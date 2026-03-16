#!/usr/bin/env node
'use strict';

/**
 * gardener-worker.js — Background process that pre-generates dormant summaries.
 *
 * Spawned detached by gardener.js. Reads a work spec JSON from stdin:
 *   { transcriptPath, candidates: [{ id, name }], sessionId }
 *
 * For each candidate (up to MAX_TOPICS):
 *   1. Reads current JSONL
 *   2. Skips if dormant summary already exists
 *   3. Calls claude --print to generate summary
 *   4. Appends dormant summary pair to JSONL (in-place write, inode preserved)
 *
 * Uses a lock file to prevent concurrent writes from multiple worker instances.
 * Logs progress to .claude/gardener-worker.log for debugging.
 * Never modifies the active chain — only appends orphaned dormant entries.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { v4: uuidv4 } = require('uuid');

// Import shared functions from context-mcp.js
const {
  getTopics,
  findDormantSummary,
  extractTopicContent,
} = require('../context-mcp.js');

const MAX_TOPICS = 5;
const LOCK_FILE = path.join(process.cwd(), '.claude', 'gardener-worker.lock');
const LOG_FILE = path.join(process.cwd(), '.claude', 'gardener-worker.log');

function log(msg) {
  try {
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
  } catch (_) {}
}

function acquireLock() {
  try {
    // Exclusive create — fails if already exists
    fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: 'wx' });
    return true;
  } catch (_) {
    // Check if stale (pid no longer running)
    try {
      const pid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8'));
      if (pid && pid !== process.pid) {
        try { process.kill(pid, 0); return false; } catch (_) {} // still running
      }
      // Stale lock — take it
      fs.writeFileSync(LOCK_FILE, String(process.pid));
      return true;
    } catch (_) {
      return false;
    }
  }
}

function releaseLock() {
  try { fs.unlinkSync(LOCK_FILE); } catch (_) {}
}

function readHistory(filePath) {
  return fs.readFileSync(filePath, 'utf8')
    .split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

function writeHistory(filePath, entries) {
  fs.writeFileSync(filePath, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
}

function generateSummary(topicContent, topicName, messageCount) {
  const prompt =
    `You completed the following conversation topic as a subagent. Write a completion report in the standard subagent format.\n\n` +
    `Topic: "${topicName}" (${messageCount} messages)\n\n` +
    `Format your response exactly like this:\n` +
    `## Summary\n[1-2 sentences: what was accomplished]\n\n` +
    `## Key Outcomes\n- [bullet: decision, change, or result]\n- [bullet: ...]\n\n` +
    `## Final State\n[1-2 sentences: current state of files/systems/data after the work, or "No persistent changes."]\n\n` +
    `Rules:\n` +
    `- Do not reproduce raw tool output, data blobs, or verbatim identifiers from tool results\n` +
    `- Synthesize and compress — describe what happened, not what the data contained\n` +
    `- Keep total response under 200 words\n\n` +
    `---\n${topicContent}`;

  const result = spawnSync('claude', [
    '--print', prompt,
    '--output-format', 'text',
    '--model', 'claude-haiku-4-5-20251001',
  ], {
    cwd: os.tmpdir(),
    env: { ...process.env },
    timeout: 60000,
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
  });

  if (result.status !== 0 || !result.stdout?.trim()) {
    throw new Error(result.stderr?.trim() || `claude --print exited ${result.status}`);
  }
  return result.stdout.trim();
}

function appendDormantSummary(filePath, topic, summaryText, entries) {
  const topicUuids = new Set(topic.messages.map(m => m.uuid));
  const templateEntry = entries.find(e => topicUuids.has(e.uuid)) || entries[0];
  const toolUseId = `toolu_summary_${uuidv4().replace(/-/g, '').substring(0, 20)}`;
  const assistantUuid = uuidv4();
  const resultUuid = uuidv4();
  const agentId = uuidv4().replace(/-/g, '').substring(0, 17);
  const promptId = uuidv4();
  const now = new Date().toISOString();

  const summaryText_ =
    `[SUMMARY of "${topic.name}" (original: ${topic.id}) — ${topic.messages.length} messages condensed]\n\n${summaryText}`;

  const assistantEntry = {
    uuid: assistantUuid,
    parentUuid: null,
    dormantSummaryFor: topic.id,
    type: 'assistant',
    sessionId: templateEntry.sessionId,
    timestamp: now,
    cwd: templateEntry.cwd,
    version: templateEntry.version,
    message: {
      model: 'claude-haiku-4-5-20251001',
      role: 'assistant',
      stop_reason: 'tool_use',
      content: [{
        type: 'tool_use',
        id: toolUseId,
        name: 'Agent',
        input: {
          description: `Summarize topic: ${topic.name}`,
          subagent_type: 'summarizer',
          prompt: `Summarize this topic for context compression: ${topic.name}`,
        },
        caller: { type: 'direct' },
      }],
    },
  };

  const resultEntry = {
    uuid: resultUuid,
    parentUuid: assistantUuid,
    dormantSummaryFor: topic.id,
    promptId,
    type: 'user',
    sessionId: templateEntry.sessionId,
    timestamp: now,
    cwd: templateEntry.cwd,
    version: templateEntry.version,
    message: {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: [{ type: 'text', text: summaryText_ }],
      }],
    },
  };

  // Re-read before writing to pick up any entries appended since we last read
  const fresh = readHistory(filePath);
  writeHistory(filePath, [...fresh, assistantEntry, resultEntry]);
}

async function main() {
  let spec;
  try {
    const input = fs.readFileSync(0, 'utf8');
    spec = JSON.parse(input);
  } catch (e) {
    log(`Failed to read work spec: ${e.message}`);
    process.exit(0);
  }

  const { transcriptPath, candidates } = spec;
  if (!transcriptPath || !candidates?.length) process.exit(0);
  if (!fs.existsSync(transcriptPath)) process.exit(0);

  if (!acquireLock()) {
    log(`Lock held by another worker, exiting`);
    process.exit(0);
  }

  try {
    const toProcess = candidates.slice(0, MAX_TOPICS);
    log(`Starting: ${toProcess.length} topics to summarize in ${transcriptPath}`);

    for (const candidate of toProcess) {
      try {
        // Re-read on each iteration to get the latest state
        const entries = readHistory(transcriptPath);
        const topics = getTopics(entries);
        const topic = topics.find(t => t.id === candidate.id);

        if (!topic) {
          log(`Topic ${candidate.id} not found, skipping`);
          continue;
        }

        // Skip if already has a dormant summary
        if (findDormantSummary(entries, topic.id)) {
          log(`Topic "${topic.name}" already has dormant summary, skipping`);
          continue;
        }

        const content = extractTopicContent(entries, topic);
        log(`Summarizing "${topic.name}" (${topic.messages.length} msgs, ${content.length} chars)`);

        const summaryText = generateSummary(content, topic.name, topic.messages.length);
        appendDormantSummary(transcriptPath, topic, summaryText, entries);
        log(`Done: "${topic.name}"`);
      } catch (e) {
        log(`Error summarizing "${candidate.name}": ${e.message}`);
      }
    }

    log(`Worker finished`);
  } finally {
    releaseLock();
  }
}

main();
