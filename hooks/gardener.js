#!/usr/bin/env node
'use strict';

/**
 * Context Gardener — Stop hook that suggests /prune when stale topics are detected.
 *
 * Two-tier detection:
 * 1. Structural: topics with tool_result content but no dormant summary (fast, no LLM)
 * 2. Semantic: LLM reasoning via claude --print --model claude-haiku-4-5 (only when needed)
 *
 * Exits 2 with a specific suggestion if candidates found. Silent (exit 0) otherwise.
 * Never modifies the session file.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { getTokenUsage } = require('./usage.js');
const { getTopics, findDormantSummary, extractTopicContent } = require('../context-mcp.js');

const GARDENER_STATE = '.claude/gardener-state.json';

// --- State management ---

function loadState(sessionId) {
  try {
    if (fs.existsSync(GARDENER_STATE)) {
      const state = JSON.parse(fs.readFileSync(GARDENER_STATE, 'utf8'));
      if (state.sessionId === sessionId) return state;
    }
  } catch (_) {}
  return { sessionId, suggestedTopics: [] };
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

function tier1Scan(topics, entries, suggestedTopics) {
  // All topics except the last (current)
  const candidates = [];
  const nonCurrent = topics.slice(0, -1);
  for (const topic of nonCurrent) {
    if (suggestedTopics.includes(topic.id)) continue;
    if (!hasToolResults(topic.messages, entries)) continue;
    if (findDormantSummary(entries, topic.id)) continue; // already summarized
    const size = toolResultSize(topic.messages, entries);
    candidates.push({
      id: topic.id,
      name: topic.name,
      reason: size > 2048
        ? `unsummarized tool results (~${Math.round(size / 1024)}KB)`
        : 'unsummarized tool results',
      op: 'summarize',
      size,
    });
  }
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
    `Which topics (if any) are no longer relevant to the current work and are safe to summarize or forget?\n\n` +
    `Respond with JSON only — no markdown, no explanation:\n` +
    `{ "action": "NO_ACTION" }\n` +
    `OR\n` +
    `{ "action": "SUGGEST", "candidates": [{ "id": "...", "name": "...", "reason": "one line", "op": "summarize" }] }\n\n` +
    `Rules:\n` +
    `- Only flag topics that are clearly done or unrelated to current work\n` +
    `- If uncertain, respond NO_ACTION\n` +
    `- Never flag the most recent topic\n` +
    `- Prefer "summarize" over "forget"`;

  try {
    const result = spawnSync('claude', [
      '--print', prompt,
      '--output-format', 'text',
      '--model', 'claude-haiku-4-5',
    ], {
      cwd: os.tmpdir(),
      env: { ...process.env },
      timeout: 25000,
      encoding: 'utf8',
      maxBuffer: 512 * 1024,
    });

    if (result.status !== 0 || !result.stdout?.trim()) return [];

    // Extract JSON from response (strip any accidental markdown)
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

// --- Output message ---

function buildMessage(candidates, usagePct) {
  const names = candidates.map(c => `"${c.name}"`).join(' and ');
  const reasons = candidates.map(c => `  • ${c.name}: ${c.reason}`).join('\n');

  if (usagePct >= 85) {
    return `[CRITICAL] Context at ${Math.round(usagePct)}%. Stale topics detected:\n${reasons}\nRun /prune immediately.`;
  }
  if (usagePct >= 60) {
    return `[URGENT] Context at ${Math.round(usagePct)}%. ${names} look stale:\n${reasons}\nRun /prune now.`;
  }
  return `Context gardener: ${names} look done.\n${reasons}\nRun /prune to compress them.`;
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
    const candidates1 = tier1Scan(topics, entries, state.suggestedTopics);

    // Tier 2: LLM — run if tier 1 found nothing and usage > 40%, or usage > 85%
    let candidates2 = [];
    if ((candidates1.length === 0 && usagePct > 40) || usagePct > 85) {
      candidates2 = tier2Reason(topics, entries, usagePct);
    }

    // Merge, deduplicate, filter already-suggested
    const seen = new Set();
    const all = [...candidates1, ...candidates2].filter(c => {
      if (state.suggestedTopics.includes(c.id)) return false;
      if (seen.has(c.id)) return false;
      seen.add(c.id);
      return true;
    });

    if (all.length === 0) return;

    // Persist suggestions so we don't nag again this session
    state.suggestedTopics.push(...all.map(c => c.id));
    saveState(state);

    process.stderr.write(buildMessage(all, usagePct) + '\n');
    process.exit(2);
  } catch (_) {
    process.exit(0);
  }
}

main();
