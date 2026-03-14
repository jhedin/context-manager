# Context Manager for Claude Code

A Claude Code plugin that gives you control over your session's context window. Prune old topics, summarize verbose tool output, branch and merge conversation history, and auto-manage context pressure.

## Install

```bash
# From GitHub (once published)
claude plugin add https://github.com/YOUR_USERNAME/context-manager

# Or test locally
claude --plugin-dir /path/to/context-manager
```

After installing, restart Claude Code or run `/reload-plugins`.

## What it does

Claude Code sessions grow as you work. Tool outputs, debugging loops, and exploration consume context until auto-compact kicks in and removes your history unpredictably. This plugin lets you manage that proactively.

### Auto-prune (hands-free)

The Stop hook monitors your context usage and triggers automatic pruning:

| Threshold | Action |
|-----------|--------|
| **40%** | Tells the agent to `/prune` — summarize top 3-4 candidates |
| **60%** | Tells the agent to `/prune` — summarize all high-scoring topics |
| **85%** | Emergency — bypass all tool-heavy topics immediately |

Each threshold fires once per session. The agent runs `/prune`, picks the best candidates, summarizes them, and erases the prune interaction from history so you never see it.

### Manual commands

| Command | Description |
|---------|-------------|
| `/prune` | Interactively prune session history — summarize, bypass, or restore topics |
| `/branch` | Rewind to a topic, inject new context, then `/merge` the rest back |
| `/merge` | Re-append the staged future after a `/branch` |
| `/restore` | Restore from an automatic backup |

### Dormant summaries

When you `/prune`, the plugin pre-generates summaries for remaining topics and stores them as dormant entries (not linked into the chain). Next time you prune, those topics show `[READY]` — summarization is instant, no LLM call needed.

## How it works

Session files are JSONL with a `parentUuid`-linked DAG. The plugin:

1. **Detects topics** by scanning for assistant messages starting with "Now"/"Next" (topic boundaries)
2. **Scores topics** by size, tool-heaviness, and recency
3. **Summarizes** by replacing N messages with 1 condensed summary entry
4. **Bypasses** by reparenting the downstream entry around the topic (reversible)
5. **Preserves originals** as orphaned entries for `/restore`

### Architecture

```
context-mcp.js          MCP server — 11 tools for DAG manipulation
hooks/stop.js           Stop hook — reparent cleanup + auto-prune monitor
hooks/pre-backup.js     PreToolUse — backup before every write
hooks/post-forget-prune.js  PostToolUse — early reparent pass
skills/prune/           /prune skill orchestration
skills/branch/          /branch skill
skills/merge/           /merge skill
skills/restore/         /restore skill
```

## Requirements

- Claude Code CLI
- Node.js 18+
- npm dependencies: `@modelcontextprotocol/sdk`, `uuid`

Run `npm install` in the plugin directory if dependencies aren't installed.

## Configuration

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE` | (auto-detect) | Override max token limit |
| `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` | `90` | Auto-compact threshold (emergency prune fires 5% below) |
