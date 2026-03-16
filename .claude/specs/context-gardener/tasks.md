# Tasks: Context Gardener Hook

## Implementation Checklist

- [x] 1. Extract shared token usage utility
  - Create `hooks/usage.js` with `getTokenUsage(lines)` → `{ usagePct, currentUsage, maxTokens, modelId }`
  - Copy `MODEL_LIMITS` map and walk-backwards logic from `stop.js`
  - Update `stop.js` to import from `hooks/usage.js` instead of inlining

- [x] 2. Export helpers from context-mcp.js
  - Add `module.exports = { getTopics, findDormantSummary, extractTopicContent }` at bottom
  - Wrap server startup in `if (require.main === module)` guard so importing doesn't start the MCP server
  - Verify `npm test` still passes after the guard change

- [x] 3. Implement `hooks/gardener.js` — skeleton + state management
  - Read stdin → `hookData`, guard `stop_hook_active`
  - Read session JSONL, call `getTopics(entries)`
  - Guard: fewer than 3 topics → exit 0
  - Load/save `.claude/gardener-state.json` (reset on new sessionId, track `suggestedTopics[]`)
  - Get token usage via `hooks/usage.js`

- [x] 4. Implement Tier 1 structural scan
  - For each non-current topic: check for `tool_result` blocks in entries, check no dormant summary via `findDormantSummary`
  - Measure raw tool_result content size → flag high-priority if > 2KB
  - Filter out topics already in `suggestedTopics`
  - Return `candidates[]` with `{ id, name, reason, op: 'summarize' }`

- [x] 5. Implement Tier 2 LLM reasoning
  - Only run if: tier 1 found no candidates AND usage > 40%, OR usage > 85%
  - Build prompt with topic list + previews + current topic name + usage%
  - Spawn `claude --print --model claude-haiku-4-5` from `os.tmpdir()`, `spawnSync`, 25s timeout (Haiku for classification — fast, cheap)
  - Parse JSON response: `NO_ACTION` → skip, `SUGGEST` → merge with tier 1 candidates
  - On timeout or parse error: skip tier 2 silently, proceed with tier 1 only

- [x] 6. Build output message and exit
  - Merge tier 1 + tier 2 candidates, deduplicate by topic id
  - If no candidates → exit 0 silently
  - If candidates found: update `gardener-state.json`, build message per urgency tier (< 60% advisory, ≥ 60% urgent, ≥ 85% critical)
  - Write message to stderr, exit 2

- [x] 7. Register gardener in hooks/hooks.json
  - Add second Stop hook entry for `node hooks/gardener.js`
  - Verify both hooks fire correctly (stop.js still works unchanged)

- [x] 8. Add gardener tests to test-hooks.js
  - gardener with 0-2 topics → exits 0, no output
  - gardener with unsummarized topic (tool_result, no dormant) → exits 2, names the topic
  - gardener with already-suggested topic → exits 0 (deduplication works)
  - gardener with all topics summarized → exits 0
  - gardener tier 2 timeout → exits 0 silently (falls back gracefully)
  - gardener at > 85% with unsummarized topics → critical urgency message

- [x] 9. Update npm scripts and verify full test suite
  - `npm test` (62 unit tests)
  - `npm run test:hooks` (existing 7 + new 6 gardener tests)
  - Manual smoke test: run a real session, verify gardener fires and suggests correctly
