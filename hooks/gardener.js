#!/usr/bin/env node
'use strict';

/**
 * Context Gardener — Stop hook that pre-generates dormant summaries for stale topics.
 *
 * Two-tier detection:
 * 1. Structural: topics with tool_result content but no dormant summary (fast, no LLM)
 * 2. Semantic: LLM reasoning via claude --print (only when tier 1 finds nothing and usage >40%)
 *
 * When candidates are found, spawns gardener-worker.js as a detached background
 * process to generate dormant summaries. The hook exits 0 immediately — it does
 * not block the next turn.
 *
 * The worker writes summaries to the JSONL directly. Next time /prune runs,
 * those topics show [READY] and activate instantly with no LLM call.
 *
 * Silent (exit 0) always. Never exits 2.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync, spawn } = require('child_process');
const { getTokenUsage } = require('./usage.js');
const { getTopics, findDormantSummary, extractTopicContent } = require('../context-mcp.js');

const GARDENER_STATE = '.claude/gardener-state.json';
const WORKER_PATH = path.join(__dirname, 'gardener-worker.js');

// --- State management ---

function loadState(sessionId) {
  try {
    if (fs.existsSync(GARDENER_STATE)) {
      const state = JSON.parse(fs.readFileSync(GARDENER_STATE, 'utf8'));
      if (state.sessionId === sessionId) return state;
    }
  } catch (_) {}
  return { sessionId, queuedTopics: [] };
}

function saveState(state) {
  try {
    fs.writeFileSync(GARDENER_STATE, JSON.stringify(state));
  } catch (_) {}
}

// --- Tier 1: structural scan ---

function toolResultSize(messages, entries) {
  const uuids = new Set(messages.map(m => m.uuid));
  let size = 0;
  for (const e of entries) {
    if (!uuids.has(e.uuid)) continue;
    const content = e.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type === 'tool_result') {
        size += JSON.stringify(block.content || '').length;
      }
    }
  }
  return size;
}

function hasToolResults(messages, entries) {
  const uuids = new Set(messages.map(m => m.uuid));
  for (const e of entries) {
    if (!uuids.has(e.uuid)) continue;
    const content = e.message?.content;
    if (!Array.isArray(content)) continue;
    if (content.some(b => b.type === 'tool_result')) return true;
  }
  return false;
}

// Minimum combined tool_result bytes before tier 1 fires.
const TIER1_MIN_TOTAL_BYTES = 10 * 1024; // 10KB

function tier1Scan(topics, entries, queuedTopics) {
  // Exclude the last 2 topics — recent work isn't stale yet
  const candidates = [];
  const scannable = topics.slice(0, -2);
  for (const topic of scannable) {
    if (queuedTopics.includes(topic.id)) continue;
    if (!hasToolResults(topic.messages, entries)) continue;
    if (findDormantSummary(entries, topic.id)) continue; // already summarized
    const size = toolResultSize(topic.messages, entries);
    candidates.push({ id: topic.id, name: topic.name, size });
  }

  // Only fire if total unsummarized content is substantial
  const totalBytes = candidates.reduce((sum, c) => sum + c.size, 0);
  if (totalBytes < TIER1_MIN_TOTAL_BYTES) return [];
  return candidates;
}

// --- Tier 2: LLM reasoning ---

function topicPreview(topic, entries) {
  try {
    const content = extractTopicContent(entries, topic);
    return content.slice(0, 300).replace(/\n+/g, ' ');
  } catch (_) {
    return topic.name;
  }
}

function tier2Reason(topics, entries, usagePct) {
  const nonCurrent = topics.slice(0, -1);
  const current = topics[topics.length - 1];
  if (!current || nonCurrent.length === 0) return [];

  const currentPreview = topicPreview(current, entries).slice(0, 150);
  const topicList = nonCurrent.map(t =>
    `- [${t.id.slice(0, 8)}] "${t.name}" (${t.messages.length} msgs)\n  Preview: ${topicPreview(t, entries)}`
  ).join('\n');

  const prompt =
    `You are a context gardener reviewing a Claude Code session's topic history.\n` +
    `Current work: "${current.name}" — ${currentPreview}\n` +
    `Context usage: ${Math.round(usagePct)}%\n\n` +
    `Topics (excluding current):\n${topicList}\n\n` +
    `Which topics (if any) are no longer relevant to the current work and are safe to summarize?\n\n` +
    `Respond with JSON only — no markdown, no explanation:\n` +
    `{ "action": "NO_ACTION" }\n` +
    `OR\n` +
    `{ "action": "SUGGEST", "candidates": [{ "id": "...", "name": "..." }] }\n\n` +
    `Rules:\n` +
    `- Only flag topics that are clearly done or unrelated to current work\n` +
    `- If uncertain, respond NO_ACTION\n` +
    `- Never flag the most recent topic`;

  try {
    const result = spawnSync('claude', [
      '--print', prompt,
      '--output-format', 'text',
      '--model', 'claude-haiku-4-5-20251001',
    ], {
      cwd: os.tmpdir(),
      env: { ...process.env },
      timeout: 25000,
      encoding: 'utf8',
      maxBuffer: 512 * 1024,
    });

    if (result.status !== 0 || !result.stdout?.trim()) return [];

    const raw = result.stdout.trim();
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return [];

    const parsed = JSON.parse(jsonMatch[0]);
    if (parsed.action !== 'SUGGEST' || !Array.isArray(parsed.candidates)) return [];
    return parsed.candidates;
  } catch (_) {
    return [];
  }
}

// --- Spawn background worker ---

function spawnWorker(transcriptPath, candidates) {
  const spec = JSON.stringify({ transcriptPath, candidates });
  try {
    const child = spawn(process.execPath, [WORKER_PATH], {
      detached: true,
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    child.stdin.write(spec);
    child.stdin.end();
    child.unref();
  } catch (_) {}
}

// --- Main ---

async function main() {
  try {
    const input = fs.readFileSync(0, 'utf8');
    if (!input) return;

    const hookData = JSON.parse(input);
    if (hookData.stop_hook_active) return;

    const transcriptPath = hookData.transcript_path;
    if (!transcriptPath || !fs.existsSync(transcriptPath)) return;

    const lines = fs.readFileSync(transcriptPath, 'utf8').split('\n').filter(l => l.trim());
    if (lines.length === 0) return;

    const entries = lines.map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);

    // Extract sessionId
    let sessionId = hookData.session_id || '';
    if (!sessionId) {
      for (let i = entries.length - 1; i >= 0; i--) {
        if (entries[i].sessionId) { sessionId = entries[i].sessionId; break; }
      }
    }

    const topics = getTopics(entries);
    if (topics.length < 3) return; // not enough history

    const tokenInfo = getTokenUsage(lines);
    const usagePct = tokenInfo?.usagePct ?? 0;

    const state = loadState(sessionId);

    // Tier 1: structural
    const candidates1 = tier1Scan(topics, entries, state.queuedTopics);

    // Tier 2: LLM — run only when tier 1 found nothing and usage is elevated
    let candidates2 = [];
    if (candidates1.length === 0 && usagePct > 40) {
      candidates2 = tier2Reason(topics, entries, usagePct);
    }

    // Merge, deduplicate, filter already-queued
    const seen = new Set();
    const all = [...candidates1, ...candidates2].filter(c => {
      if (state.queuedTopics.includes(c.id)) return false;
      if (seen.has(c.id)) return false;
      seen.add(c.id);
      return true;
    });

    if (all.length === 0) return;

    // Record queued topics so we don't re-queue next turn
    state.queuedTopics.push(...all.map(c => c.id));
    saveState(state);

    // Sort by size descending, hand top candidates to worker
    const sorted = [...all].sort((a, b) => (b.size || 0) - (a.size || 0));
    spawnWorker(transcriptPath, sorted);
  } catch (_) {
    // Never crash — silently exit 0
  }
  process.exit(0);
}

main();
