#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

/**
 * PreToolUse hook — backs up the session file before any write-path MCP tool.
 *
 * Fires BEFORE the tool executes, so even if the tool crashes mid-write,
 * the backup is safe. This is the last line of defense against data loss.
 *
 * Keeps the 10 most recent backups per session, pruning older ones.
 */

const BACKUP_DIR = '.claude/backups';
const SESSION_PATH_FILE = '.claude/session_path.txt';
const MAX_BACKUPS = 20;
const BACKUP_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function main() {
  try {
    const input = fs.readFileSync(0, 'utf8');
    if (!input) return;

    const hookData = JSON.parse(input);

    // Get session path
    let sessionPath = null;
    if (hookData.tool_input?.session_path) {
      sessionPath = hookData.tool_input.session_path;
    } else if (fs.existsSync(SESSION_PATH_FILE)) {
      sessionPath = fs.readFileSync(SESSION_PATH_FILE, 'utf8').trim();
    }

    if (!sessionPath || !fs.existsSync(sessionPath)) return;

    // Create backup directory
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

    const basename = path.basename(sessionPath, '.jsonl');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupName = `${basename}_${timestamp}.jsonl`;
    const backupPath = path.join(BACKUP_DIR, backupName);

    // Copy the session file (not rename — preserves inode of original)
    fs.copyFileSync(sessionPath, backupPath);

    // Prune: remove backups older than TTL, then cap at MAX_BACKUPS
    const now = Date.now();
    const allBackups = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith(basename + '_') && f.endsWith('.jsonl'))
      .sort()
      .reverse();

    for (let i = 0; i < allBackups.length; i++) {
      const fullPath = path.join(BACKUP_DIR, allBackups[i]);
      const age = now - fs.statSync(fullPath).mtimeMs;
      if (age > BACKUP_TTL_MS || i >= MAX_BACKUPS) {
        fs.unlinkSync(fullPath);
      }
    }
  } catch (err) {
    // Never crash a hook — backup failure shouldn't block the tool
  }
}

main();
