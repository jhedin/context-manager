#!/usr/bin/env node

const fs = require('fs');

/**
 * Claude Code Stop Hook - Context Monitor + Reparent Cleanup
 *
 * Two responsibilities:
 * 1. After forget_prune: reparent orphaned entries to the anchor UUID.
 *    forget_prune removes messages from the JSONL but the runtime re-appends
 *    entries from memory with stale parentUuids. The Stop hook is the only
 *    reliable point where ALL entries have been written.
 * 2. Context monitor: if usage exceeds threshold, block stop to inject pruning.
 */

const REPARENT_MARKER = '.claude/pending_reparent.json';

const MODEL_LIMITS = {
  'claude-opus-4-6':   1000000,
  'claude-sonnet-4-6': 1000000,
  'claude-sonnet-4-5': 1000000,
  'claude-haiku-4-5':   200000,
  // Legacy model IDs
  'claude-3-7-sonnet':  200000,
  'claude-3-5-sonnet':  200000,
  'claude-3-5-haiku':   200000,
};

/**
 * Reparent orphaned entries after forget_prune.
 * Reads the marker file to get the anchor UUID, then fixes any entries
 * whose parentUuid points to a UUID not in the file.
 */
const REPARENT_LOG = '.claude/hooks/reparent-stop.log';

function reparentLog(msg) {
  const ts = new Date().toISOString();
  fs.appendFileSync(REPARENT_LOG, `[${ts}] ${msg}\n`);
}

function reparentOrphans(sessionPath) {
  if (!fs.existsSync(REPARENT_MARKER)) return;

  reparentLog('Stop hook: marker found');

  try {
    const marker = JSON.parse(fs.readFileSync(REPARENT_MARKER, 'utf8'));
    const { anchorUuid } = marker;
    const filePath = sessionPath || marker.sessionPath;
    reparentLog(`anchor=${anchorUuid}, path=${filePath}`);
    if (!anchorUuid || !filePath || !fs.existsSync(filePath)) {
      reparentLog('Missing anchor/path, exiting.');
      return;
    }

    const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(l => l.trim());
    const entries = lines.map(l => JSON.parse(l));
    reparentLog(`Session has ${entries.length} entries`);

    // Build set of all known UUIDs
    const allUuids = new Set();
    for (const e of entries) {
      if (e.uuid) allUuids.add(e.uuid);
    }

    // Reparent any entry whose parentUuid is missing
    let reparented = 0;
    const orphanDetails = [];
    const result = entries.map(e => {
      if (e.parentUuid && !allUuids.has(e.parentUuid)) {
        reparented++;
        orphanDetails.push(`uuid=${e.uuid?.slice(0,16)} parent=${e.parentUuid?.slice(0,16)} type=${e.type}`);
        return { ...e, parentUuid: anchorUuid };
      }
      return e;
    });

    reparentLog(`Found ${reparented} orphans: ${JSON.stringify(orphanDetails)}`);

    if (reparented > 0) {
      fs.writeFileSync(filePath, result.map(e => JSON.stringify(e)).join('\n') + '\n');
      reparentLog(`Wrote ${result.length} entries (reparented ${reparented})`);
    }

    // Clean up marker
    fs.unlinkSync(REPARENT_MARKER);
    reparentLog('Marker deleted.');
  } catch (err) {
    reparentLog(`ERROR: ${err.message}\n${err.stack}`);
    try { fs.unlinkSync(REPARENT_MARKER); } catch (_) {}
  }
}

async function main() {
  try {
    const input = fs.readFileSync(0, 'utf8');
    if (!input) return;

    const hookData = JSON.parse(input);

    // Guard against infinite loops: if this hook already caused a continuation, let the stop proceed
    if (hookData.stop_hook_active) return;

    const transcriptPath = hookData.transcript_path;
    if (!transcriptPath) return;

    // Always check for pending reparent first (before any early returns)
    reparentOrphans(transcriptPath);

    // Write session path so the MCP server can auto-discover it
    fs.writeFileSync('.claude/session_path.txt', transcriptPath);

    const lines = fs.readFileSync(transcriptPath, 'utf8').split('\n').filter(l => l.trim());
    if (lines.length === 0) return;

    // Find the last message with usage info (walk backwards)
    let usage = null;
    let modelId = '';
    for (let i = lines.length - 1; i >= 0; i--) {
      const entry = JSON.parse(lines[i]);
      if (entry.message?.usage) {
        usage = entry.message.usage;
        modelId = entry.message.model || '';
        break;
      }
    }

    if (!usage) return;

    // Determine max tokens: env override > model map > default 1M
    let maxTokens = parseInt(process.env.CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE) || 0;
    if (!maxTokens) {
      const modelMatch = Object.keys(MODEL_LIMITS).find(m => modelId.includes(m));
      maxTokens = modelMatch ? MODEL_LIMITS[modelMatch] : 1000000;
    }

    // Trigger at 85% by default, or 5% below auto-compact threshold
    const autoCompactPct = parseInt(process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE) || 90;
    const triggerPct = Math.max(70, autoCompactPct - 5);

    const currentUsage = usage.input_tokens;
    const usagePercent = (currentUsage / maxTokens) * 100;

    if (usagePercent > triggerPct) {
      process.stderr.write(
        `[CONTEXT MONITOR] Model: ${modelId}\n` +
        `Usage: ${Math.round(usagePercent)}% of ${maxTokens.toLocaleString()} tokens (${currentUsage.toLocaleString()} input tokens).\n` +
        `ACTION REQUIRED: Use the list_topics tool from the context-manager MCP to review topics, ` +
        `then ask the user which topics to BYPASS. Use bypass_topic to remove selected topics.`
      );
      process.exit(2);
    }
  } catch (err) {
    // Hooks must not crash — silently exit on error
    process.exit(0);
  }
}

main();
