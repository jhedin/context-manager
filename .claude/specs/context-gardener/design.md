# Design: Context Gardener Hook

## 1. Overview

The gardener lives in `hooks/gardener.js` and is registered as an additional Stop hook alongside the existing `stop.js`. It reads the session JSONL directly (no MCP connection), runs structural detection, optionally runs an LLM reasoning step, and exits 2 with a specific `/prune` suggestion if candidates are found.

---

## 2. Hook Registration

`hooks/hooks.json` gains a second Stop hook entry:

```json
{
  "hooks": {
    "Stop": [
      { "hooks": [{ "type": "command", "command": "node hooks/stop.js" }] },
      { "hooks": [{ "type": "command", "command": "node hooks/gardener.js" }] }
    ]
  }
}
```

Both hooks fire on every Stop. `stop.js` handles reparent cleanup and raw token thresholds. `gardener.js` handles relevance-based pruning suggestions. They are independent — order doesn't matter.

---

## 3. File Layout

```
hooks/
  stop.js           # existing — token thresholds + reparent
  gardener.js       # new — relevance detection + /prune suggestion
  gardener-state.json  # runtime: tracks which topics have been suggested this session
```

State file lives at `.claude/gardener-state.json` (same convention as `auto_prune_state.json`).

---

## 4. Gardener Flow

```
gardener.js starts
├── read stdin → hookData (session_id, transcript_path, usage)
├── guard: stop_hook_active? → exit 0
├── read session JSONL → entries
├── getTopics(entries) → topics[]
├── guard: fewer than 3 topics? → exit 0
├── get current token usage %
│
├── TIER 1: structural scan
│   ├── for each non-current topic:
│   │   ├── has tool_result blocks?
│   │   ├── has NO dormant summary?
│   │   └── tool_result content > 2KB? → high priority
│   └── candidates1[] (unsummarized topics)
│
├── if candidates1 is non-empty OR usage > 40%:
│   ├── TIER 2: LLM reasoning (claude --print from os.tmpdir())
│   │   ├── input: topic list + previews + current topic + usage%
│   │   └── output: NO_ACTION | [{id, name, reason, action}]
│   └── candidates2[] (semantic candidates)
│
├── merge candidates: candidates1 ∪ candidates2, deduplicate by topic id
├── filter out topics already suggested this session (gardener-state.json)
│
├── if no candidates → exit 0 (silent)
└── if candidates found:
    ├── update gardener-state.json (mark topics as suggested)
    ├── build message (see §6)
    └── exit 2
```

---

## 5. Reusing Context-MCP Logic

`gardener.js` imports helper functions directly from `context-mcp.js` rather than duplicating them:

```js
const { getTopics, findDormantSummary } = require('./context-mcp.js');
```

This requires those functions to be exported. `context-mcp.js` currently does not export — add:

```js
module.exports = { getTopics, findDormantSummary, extractTopicContent };
```

The MCP server entry point (`server.start()`) must be guarded so importing doesn't start the server:

```js
if (require.main === module) {
  const transport = new StdioServerTransport();
  server.connect(transport);
}
```

---

## 6. Tier 2 LLM Prompt

```
You are a context gardener reviewing a Claude Code session's topic history.
Current work: "{currentTopicName}" — {currentTopicPreview}
Context usage: {usagePct}%

Topics (excluding current):
{topics.map(t => `- [${t.id.slice(0,8)}] "${t.name}" (${t.messages.length} msgs, ~${t.estimatedTokens} tokens)\n  Preview: ${t.preview}`).join('\n')}

Which topics (if any) are no longer relevant to the current work and are safe to summarize or forget?

Respond with JSON only:
{ "action": "NO_ACTION" }
OR
{ "action": "SUGGEST", "candidates": [{ "id": "...", "name": "...", "reason": "one line", "op": "summarize"|"forget" }] }

Rules:
- Only flag topics that are clearly done or unrelated to current work
- If uncertain, respond NO_ACTION
- Never flag the most recent topic
- Prefer "summarize" over "forget" unless the topic is trivially short or fully superseded
```

---

## 7. Output Message Format

Low urgency (< 60%):
```
Context gardener: "Initial setup" and "Fix broken import" look done — both have unsummarized tool results.
Run /prune to compress them.
```

Urgent (≥ 60%):
```
[URGENT] Context at 67%. "Debug session" (unsummarized, 8KB) and "File exploration" look stale.
Run /prune now.
```

Emergency (≥ 85%):
```
[CRITICAL] Context at 87%. Unsummarized topics detected. Run /prune immediately.
```

---

## 8. Gardener State

`.claude/gardener-state.json`:
```json
{
  "sessionId": "abc123",
  "suggestedTopics": ["topic-uuid-1", "topic-uuid-2"]
}
```

- Reset when `sessionId` changes (new session)
- Topic IDs added after each suggestion
- Prevents re-nagging about the same topic in the same session
- If a topic gets summarized and the gardener encounters it again, `findDormantSummary` will return a result → it won't be flagged again naturally

---

## 9. Timeout and Safety

- Gardener (classification): `claude --print --model claude-haiku-4-5`, timeout 25s — Haiku is sufficient for yes/no topic relevance judgment
- Summary generation (`generateSummaryWithAPI` in `context-mcp.js`): `claude --print --model claude-opus-4-6` — Opus needed to produce coherent compressed prose that replaces pages of context
- If timeout or non-zero exit: skip tier 2, proceed with tier 1 candidates only
- All logic wrapped in try/catch → exit 0 on any error
- Never calls `summarize_topic`, `forget_prune`, or any write MCP tool
- Reads session file but never writes to it

---

## 10. Token Usage Source

Reuse `stop.js` approach: walk session JSONL backwards to find last entry with `message.usage`, compute `(input_tokens / maxTokens) * 100`. Same `MODEL_LIMITS` map. Extract this into a shared `hooks/usage.js` utility both hooks import.
