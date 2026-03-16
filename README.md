# Context Manager for Claude Code

A Claude Code plugin that gives you control over your session's context window. Prune old topics, summarize verbose tool output, branch and merge conversation history, and auto-manage context pressure.

## Install

```bash
# Add this repo as a marketplace, then install
claude plugins marketplace add https://github.com/jhedin/context-manager
claude plugins install context-manager
```

Restart Claude Code after installing to activate the hooks and MCP server.

To test locally without installing:
```bash
claude --plugin-dir /path/to/context-manager
```

## What it does

Claude Code sessions grow as you work. Tool outputs, debugging loops, and exploration consume context until auto-compact kicks in and removes your history unpredictably. This plugin lets you manage that proactively.

### Auto-prune (hands-free)

Two hooks work together to manage context automatically:

**Context Gardener** — fires after every turn, suggests `/prune` when it finds stale content:
- Tier 1 (structural): detects topics with unsummarized tool_result content — no LLM, instant
- Tier 2 (semantic): uses Haiku to reason about topic relevance when tier 1 finds nothing and usage is >40%
- Names specific topics in its suggestion; silent when nothing needs pruning

**Token threshold monitor** — fires at fixed usage levels:

| Threshold | Action |
|-----------|--------|
| **40%** | Suggests `/prune` — summarize top 3-4 candidates |
| **60%** | Suggests `/prune` — summarize all high-scoring topics |
| **85%** | Emergency — bypass all tool-heavy topics immediately |

Each threshold fires once per session.

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
context-mcp.js              MCP server — 12 tools for DAG manipulation
hooks/stop.js               Stop hook — reparent cleanup + token threshold monitor
hooks/gardener.js           Stop hook — relevance-based /prune suggestions
hooks/usage.js              Shared token usage utility
hooks/pre-backup.js         PreToolUse — backup before every write
hooks/post-forget-prune.js  PostToolUse — early reparent pass
skills/prune/               /prune skill orchestration
skills/branch/              /branch skill
skills/merge/               /merge skill
skills/restore/             /restore skill
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
