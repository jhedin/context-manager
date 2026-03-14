#!/usr/bin/env node

const fs = require('fs');

/**
 * Claude Code Stop Hook - Context Monitor + Reparent Cleanup
 *
 * Three responsibilities:
 * 1. After forget_prune: reparent orphaned entries to the anchor UUID.
 * 2. Auto-prune: at 40% and 60% context, tell the agent to run /prune itself.
 * 3. Emergency warning: at 85%+, block and demand immediate manual pruning.
 */

const REPARENT_MARKER = '.claude/pending_reparent.json';
const AUTO_PRUNE_STATE = '.claude/auto_prune_state.json';

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

/**
 * Track which auto-prune thresholds have already fired this session.
 * Prevents repeating the same prune request on every stop.
 */
function getAutoPruneState(sessionId) {
  try {
    if (fs.existsSync(AUTO_PRUNE_STATE)) {
      const state = JSON.parse(fs.readFileSync(AUTO_PRUNE_STATE, 'utf8'));
      if (state.sessionId === sessionId) return state;
    }
  } catch (_) {}
  return { sessionId, firedThresholds: [] };
}

function setAutoPruneState(state) {
  fs.writeFileSync(AUTO_PRUNE_STATE, JSON.stringify(state));
}

async function main() {
  try {
    const input = fs.readFileSync(0, 'utf8');
    if (!input) return;

    const hookData = JSON.parse(input);

    // Guard against infinite loops: if this hook already caused a continuation
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
    let sessionId = '';
    for (let i = lines.length - 1; i >= 0; i--) {
      const entry = JSON.parse(lines[i]);
      if (!sessionId && entry.sessionId) sessionId = entry.sessionId;
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

    const currentUsage = usage.input_tokens;
    const usagePercent = (currentUsage / maxTokens) * 100;

    // Load auto-prune state to avoid repeating thresholds
    const state = getAutoPruneState(sessionId);

    // --- Tiered context management ---

    // Tier 1: 40% — gentle auto-prune (summarize top candidates)
    if (usagePercent >= 40 && usagePercent < 60 && !state.firedThresholds.includes(40)) {
      state.firedThresholds.push(40);
      setAutoPruneState(state);
      process.stderr.write(
        `[AUTO-PRUNE] Context at ${Math.round(usagePercent)}% (${currentUsage.toLocaleString()} / ${maxTokens.toLocaleString()} tokens).\n` +
        `Run /prune now. SUMMARIZE the top 3-4 recommended topics to free space. ` +
        `Choose "Yes, forget" to erase the prune interaction afterward.`
      );
      process.exit(2);
    }

    // Tier 2: 60% — aggressive auto-prune (summarize all high-scoring topics)
    if (usagePercent >= 60 && usagePercent < 85 && !state.firedThresholds.includes(60)) {
      state.firedThresholds.push(60);
      setAutoPruneState(state);
      process.stderr.write(
        `[AUTO-PRUNE] Context at ${Math.round(usagePercent)}% — getting tight.\n` +
        `Run /prune now. SUMMARIZE all recommended topics and any other active topics with high token counts. ` +
        `Choose "Yes, forget" to erase the prune interaction afterward.`
      );
      process.exit(2);
    }

    // Tier 3: 85% — emergency, demand immediate action
    const autoCompactPct = parseInt(process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE) || 90;
    const emergencyPct = Math.max(70, autoCompactPct - 5);

    if (usagePercent > emergencyPct) {
      process.stderr.write(
        `[CONTEXT CRITICAL] ${Math.round(usagePercent)}% of ${maxTokens.toLocaleString()} tokens used.\n` +
        `Run /prune immediately. BYPASS all tool-heavy topics. Auto-compact will fire at ${autoCompactPct}%.`
      );
      process.exit(2);
    }
  } catch (err) {
    // Hooks must not crash — silently exit on error
    process.exit(0);
  }
}

main();
