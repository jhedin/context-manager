# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A Claude Code plugin that manages session context via DAG manipulation of JSONL session files. The MCP server (`context-mcp.js`) exposes 12 tools, hooks handle cleanup and auto-pruning, and skills orchestrate multi-step workflows.

## Commands

```bash
npm install          # Install deps (@modelcontextprotocol/sdk, uuid)
npm run build        # TypeScript type check (tsc --noEmit, no output)
npm test             # Run DAG bypass logic tests
node context-mcp.js  # Start MCP server (normally launched by Claude Code via .mcp.json)
```

Test locally as a plugin:
```bash
claude --plugin-dir /path/to/this/repo
```

## Architecture

### Session DAG Model

Session files are JSONL where each entry has `uuid` and `parentUuid` forming a singly-linked chain. The **active chain** walks backward from the tail (entry with no children) to the root. Entries not in the active chain are **orphans** — disconnected but preserved in the file for potential restore.

### Three Cooperating Systems

1. **MCP Server** (`context-mcp.js`): Stateless — reads the JSONL, mutates an in-memory array, writes back. All writes use `writeFileSync` (not rename) to preserve the inode that Claude Code's open fd points to.

2. **Hooks** (`hooks/`): Fire around tool calls and at session stop. The Stop hook has two jobs: reparent orphaned entries after `forget_prune` (via `.claude/pending_reparent.json` marker), and monitor context usage to trigger auto-pruning at 40%/60%/85%.

3. **Skills** (`skills/`): Markdown orchestration scripts that tell the LLM which tools to call in what order. The `/prune` skill is the primary interface.

### Key Patterns

**Reparenting**: To remove a topic, reparent the downstream entry to skip over it. The topic's entries become orphans. To restore, reparent back. Never delete entries — orphan them.

**Dormant Summaries**: Pre-built summary entries appended with `dormantSummaryFor: topicId` and `parentUuid: null`. Not linked into the chain until `summarize_topic` activates them. Avoids re-generating summaries on each prune. `findActiveTail()` and `getTopics()` skip entries with `dormantSummaryFor`.

**Two-Hook Reparenting**: After `forget_prune` removes tail entries, the runtime re-appends from its in-memory buffer with stale parentUuids. PostToolUse does an early reparent pass, Stop hook does the final cleanup and deletes the marker.

**Inflight Guard**: `guardInflight()` blocks write tools if external tool calls, subagents, or background tasks are pending. Own MCP tools are excluded via prefix match (`mcp__context-manager__`).

### Topic Detection

`getTopics()` splits history at entries where the assistant text starts with "Now " or "Next " (case-insensitive), or where `parentUuid` is null. Topic IDs are the UUID of the first message. This heuristic over-segments — many mid-task assistant messages start with "Now".

### Path Validation

`validateSessionPath()` restricts file operations to `.jsonl` files inside `$HOME/.claude/`, `./.claude/`, or the test fixture `test_session.jsonl`.

## Plugin Structure

```
.claude-plugin/plugin.json   # Manifest — name, version, component paths
.mcp.json                    # MCP server config (uses ${CLAUDE_PLUGIN_ROOT})
hooks/hooks.json              # Hook registrations (Stop, PreToolUse, PostToolUse)
hooks/stop.js                 # Reparent cleanup + auto-prune monitor
hooks/pre-backup.js           # Backup before write tools
hooks/post-forget-prune.js    # Early reparent after forget_prune/branch_session
skills/{prune,branch,merge,restore}/SKILL.md
context-mcp.js                # MCP server (all 12 tools)
```

The `.claude/` directory under the project root holds runtime state (backups, session path, markers, sidecar log) — not plugin code.

## Important Constraints

- **Inode preservation**: Never use `fs.renameSync` for session files. Claude Code holds an open fd; rename creates a new inode and all subsequent runtime appends go to a ghost file.
- **Hook safety**: Hooks must never crash. Catch all errors and `process.exit(0)`. A crashing hook blocks the tool it wraps.
- **Write atomicity**: Read entire file, mutate in memory, write entire file. No partial writes, no append-then-truncate.
- **Marker-based IPC**: `forget_prune` and `branch_session` communicate with hooks via `.claude/pending_reparent.json`. The PostToolUse hook leaves the marker; the Stop hook deletes it.
