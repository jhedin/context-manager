---
name: restore
description: Restore session from a backup after a failed edit
user-invocable: true
---

# Restore From Backup

Restore the session file from an automatic backup. Backups are created by the PreToolUse hook before every write operation.

## Steps

1. Call `list_backups` from the context-manager MCP.
2. If no backups found, tell the user there's nothing to restore.
3. Present the backup list to the user. Show the timestamp, entry count, and size for each. Ask which one to restore.
4. Call `restore_backup` with the chosen backup filename.
5. Tell the user: "Restored. **Type `/resume`** to reload from the backup."

## Notes

- Backups are stored in `.claude/backups/` with timestamps.
- The 10 most recent backups per session are kept; older ones are pruned automatically.
- Restoring uses `copyFileSync` (preserves inode), so the running session's fd stays valid.
- Any messages the runtime appended after the restore are automatically reparented to the backup's tail.
