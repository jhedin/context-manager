# Requirements: Context Gardener Hook

## 1. Introduction

The **Context Gardener** is a Stop hook that fires after every Claude Code turn. It reads the session's topic list, passes a structured summary to `claude --print` for relevance reasoning, and — only if stale/completed topics are found — exits with code 2 to surface a specific `/prune` suggestion to the user.

The primary trigger is **relevance**, not token count. Token pressure is a secondary urgency signal.

---

## 2. Listening Points

### EARS: When the system shall listen

- **WHEN** the Stop hook fires (after every turn), the system SHALL read the session JSONL and extract the topic list.
- **WHILE** the session has fewer than 3 topics, the system SHALL skip gardener reasoning (not enough history to prune).
- **WHEN** the most recent topic was created fewer than 2 turns ago, the system SHALL treat it as active and exclude it from pruning candidates.

---

## 3. What to Look Out For

Detection runs in two tiers. Tier 1 is structural (pure code, fast). Tier 2 is semantic (LLM reasoning, only runs if tier 1 finds nothing or token pressure warrants deeper analysis).

### Tier 1: Structural signals (code, no LLM)

- **WHEN** a topic contains one or more `tool_result` blocks AND has no corresponding dormant summary entry (`dormantSummaryFor`), the system SHALL flag it as an unsummarized candidate.
- **WHEN** an unsummarized topic's raw tool_result content exceeds 2KB, the system SHALL mark it high-priority.
- **WHEN** a topic has already been summarized (dormant summary exists and is activated), the system SHALL NOT re-flag it.

### Tier 2: Semantic signals (LLM reasoning)

- **WHEN** tier 1 finds no candidates AND token usage is above 40%, the system SHALL run the gardener LLM step.
- **WHEN** a topic's content appears to describe a completed discrete task (file edit, bug fix, research query with a resolution), the gardener SHALL flag it as a completion candidate.
- **WHEN** a topic's subject matter is unrelated to the current active topic's subject matter, the gardener SHALL flag it as an irrelevance candidate.
- **WHEN** a topic contains heavy tool_result content not referenced in recent turns, the gardener SHALL flag it as a compression candidate.

### What NOT to flag (both tiers)

- **IF** a topic contains an unresolved question or an open task, the system SHALL NOT flag it for pruning.
- **IF** a topic is the most recent topic, the system SHALL NOT flag it regardless of content.
- **IF** all topics appear relevant to the current direction of work, the system SHALL exit 0 silently.

---

## 4. When to Trigger a Pruning Suggestion

### Primary trigger: gardener finds candidates

- **WHEN** the gardener reasoning step returns one or more pruning candidates, the system SHALL exit 2 with a message naming the specific topics and why they are candidates.
- **WHEN** no candidates are found, the system SHALL exit 0 with no output (silent).

### Secondary signal: token pressure escalates urgency

- **WHEN** context is above 60% AND candidates exist, the suggestion SHALL be marked urgent.
- **WHEN** context is above 85%, the system SHALL suggest pruning even if the gardener is uncertain (lower confidence threshold).
- **WHEN** context is below 40% AND candidates exist, the suggestion SHALL be advisory (soft tone).

### Deduplication

- **WHEN** a pruning suggestion has already been made for a given topic in this session, the system SHALL NOT suggest it again unless new turns have passed (avoid repeating the same nag).

---

## 5. Gardener Reasoning Contract

The gardener receives:
- A structured topic list: topic name, message count, estimated tokens, brief content preview (first 200 chars)
- The current active topic name and a 1-sentence description of recent work
- Current token usage percentage

The gardener returns one of:
- `NO_ACTION` — all topics are relevant, do nothing
- A list of specific topic IDs with a one-line reason each: `[{id, name, reason, action: "summarize"|"forget"}]`

The gardener is a single `claude --print` call. It is synchronous — the Stop hook waits for it. Acceptable latency at Stop time since the session turn is complete.

---

## 6. Output Format (exit 2 message)

The hook message shown to the user names specific topics:

```
Context gardener: Topic "Initial setup" and "Fix broken import" look done.
Run /prune to compress them. (Context: 54%)
```

For urgent cases:
```
[URGENT] Context at 72%. Topics "Debug session", "File exploration" are stale.
Run /prune now to avoid hitting the limit.
```

---

## 7. Non-Functional Requirements

- **Silent by default**: must exit 0 with no output when no action is needed. No noise.
- **Fast enough**: gardener `claude --print` call should complete in < 30s. If it times out, exit 0 silently.
- **Hook safety**: any error in gardener logic must be caught; hook must never crash or exit non-zero unexpectedly.
- **No autonomous changes**: the gardener NEVER calls `summarize_topic` or `forget_prune` itself. It only suggests. The user runs `/prune`.
- **Runs from tmpdir**: `claude --print` spawned from `os.tmpdir()` so the gardener session doesn't pollute the current project.

---

## 8. Out of Scope

- Autonomous pruning (gardener never modifies the session itself)
- Per-message relevance scoring (topic-level granularity only)
- Multi-session memory of pruning history
