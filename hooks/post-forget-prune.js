#!/usr/bin/env node

const fs = require('fs');

/**
 * PostToolUse hook for forget_prune.
 *
 * After forget_prune truncates the session file, the Claude runtime appends
 * the tool_result (and later the assistant response) with parentUuids that
 * point to removed entries. This hook reads the marker file left by
 * forget_prune (containing the anchor UUID), finds the orphaned entries,
 * and reparents them to the anchor — same technique as backup restore.
 */

const REPARENT_MARKER = '.claude/pending_reparent.json';
const LOG_FILE = '.claude/hooks/post-forget-prune.log';

function log(msg) {
  const ts = new Date().toISOString();
  fs.appendFileSync(LOG_FILE, `[${ts}] ${msg}\n`);
}

function main() {
  try {
    // Log the hook input (stdin)
    const input = fs.readFileSync(0, 'utf8');
    log(`HOOK FIRED. stdin length=${input.length}`);
    if (input) {
      log(`stdin: ${input.slice(0, 2000)}`);
    }

    if (!fs.existsSync(REPARENT_MARKER)) {
      log('No reparent marker found, exiting.');
      return;
    }

    const marker = JSON.parse(fs.readFileSync(REPARENT_MARKER, 'utf8'));
    const { anchorUuid, sessionPath } = marker;
    log(`Marker: anchor=${anchorUuid}, path=${sessionPath}`);
    if (!anchorUuid || !sessionPath || !fs.existsSync(sessionPath)) {
      log('Missing anchor/path or file not found, exiting.');
      return;
    }

    const lines = fs.readFileSync(sessionPath, 'utf8').split('\n').filter(l => l.trim());
    const entries = lines.map(l => JSON.parse(l));
    log(`Session has ${entries.length} entries`);

    // Build set of all known UUIDs
    const allUuids = new Set();
    for (const e of entries) {
      if (e.uuid) allUuids.add(e.uuid);
    }

    // Find entries whose parentUuid points to a UUID that doesn't exist
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

    log(`Found ${reparented} orphans: ${JSON.stringify(orphanDetails)}`);

    if (reparented > 0) {
      fs.writeFileSync(sessionPath, result.map(e => JSON.stringify(e)).join('\n') + '\n');
      log(`Wrote ${result.length} entries back (reparented ${reparented})`);
    }

    // Don't delete marker — let Stop hook do a final pass
    log('Done. Leaving marker for Stop hook.');
  } catch (err) {
    log(`ERROR: ${err.message}\n${err.stack}`);
  }
}

main();
