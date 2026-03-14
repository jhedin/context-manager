---
name: prune
description: Surgically prune session history to free context space
user-invocable: true
---

# Session Pruner

Interactively prune the session history DAG to reduce context usage.

## Steps

1. **Record the anchor UUID immediately.** The user's `/prune` command is a user message in the transcript. The anchor for `forget_prune` is the message BEFORE that — typically the previous assistant or system message. Call `get_context_stats` — its response includes the session path. Then call `list_topics`. **While waiting**, use Bash to find the anchor:
   ```bash
   python3 -c "
   import json
   path = 'SESSION_PATH_HERE'
   entries = [json.loads(l) for l in open(path) if l.strip()]
   # Walk backwards to find the /prune user message, then take the one before it
   for i in range(len(entries)-1, -1, -1):
       e = entries[i]
       content = e.get('message',{}).get('content',[]) if isinstance(e.get('message'), dict) else []
       for b in content:
           if isinstance(b, dict) and b.get('type') == 'text' and '/prune' in b.get('text','')[:200]:
               # Found the /prune message - anchor is the entry before it
               for j in range(i-1, -1, -1):
                   if entries[j].get('uuid'):
                       print(f'ANCHOR={entries[j]["uuid"]}')
                       exit()
   "
   ```
   **Save this UUID — you will need it in step 7.** Do NOT use any UUID from within the prune interaction itself.
2. The `list_topics` response includes per-topic token estimates, tool-heaviness flags, `[READY]` tags for topics with pre-built dormant summaries, and a RECOMMENDED section with the highest-scoring prune candidates.
3. Use `AskUserQuestion` with TWO questions in a single call:
   - **Question 1** (multiSelect: false, header: "Action"): "What action?" — options:
     - **SUMMARIZE** — replace topic with a condensed summary (preserves key decisions, removes verbose tool output)
     - **BYPASS** — completely remove topic from active chain (most aggressive, but reversible)
     - **RESTORE** — undo a previous bypass or summarize (re-insert orphaned topic back into active chain)
   - **Question 2** (multiSelect: false, header: "Topics"): "Which topics?" — use the top 3-4 recommended topic IDs as options. User can pick "Other" for custom comma-separated IDs.
4. Parse the user's answer. If they selected "Other" and typed IDs, split on commas/spaces.
5. Execute the chosen action for each topic ID:
   - **SUMMARIZE**:
     - If the topic has a `[READY]` tag, call `summarize_topic` with just the topic_id — the dormant summary activates instantly, no summary text needed.
     - Otherwise, call `get_topic_content` first, write a tight summary of key decisions/outcomes/state changes (2-4 sentences), then call `summarize_topic` with your summary.
   - **BYPASS**: Call `bypass_topic`.
   - **RESTORE**: The user wants to restore the *original content* that was replaced by a summary or bypass. If the selected topic is a summary entry (text starts with `[SUMMARY of`), you need to find and restore the **original orphaned topic** it replaced — look in `list_topics` output for an orphaned topic whose content matches what the summary describes. Call `restore_topic` with the *original* topic's ID, not the summary's ID. The restore operation will re-insert the original messages and orphan the summary.
6. **Pre-generate dormant summaries for remaining topics.** After completing the user's chosen action, look at the remaining active topics that don't have `[READY]` tags. For each one, call `get_topic_content` and then `prepare_summary` with a tight summary. This ensures future `/prune` calls can activate summaries instantly. Do this in the background if possible.
7. Call `get_context_stats` again to show the before/after comparison.
8. **Final cleanup**: Use `AskUserQuestion` with ONE question:
   - **Question** (multiSelect: false, header: "Cleanup"): "Erase the pruning interaction itself from history?" — options:
     - **Yes, forget** — removes this entire /prune conversation from the active chain so resumed session has no memory of pruning
     - **No, keep** — leaves the pruning interaction visible in history
   - If "Yes", call `forget_prune` with the **anchor UUID you recorded in step 1**. This UUID MUST be from BEFORE the /prune command — not from any message within the prune interaction. This must be the LAST tool call.
9. Tell the user: **Type `/resume` and select this session to reload with updated history.**

## Summary Guidelines

When writing summaries for SUMMARIZE or prepare_summary, focus on:
- What was decided or changed (not how)
- Final state of files modified
- Key outcomes and errors encountered
- Skip: intermediate debugging steps, tool output, iteration attempts

Keep summaries to 2-4 sentences. The goal is ~100 tokens replacing potentially thousands.

## Rules

- Default recommendation should be SUMMARIZE over BYPASS — it preserves context while reducing size.
- Orphans are already disconnected from active chain — only recommend active topics for pruning.
- If a tool returns an error about in-flight work, tell the user to wait for background tasks to finish.
- If a tool returns a file-changed race error, retry once automatically.
- Topics with `[READY]` tags have dormant summaries — summarize_topic is instant for these (no get_topic_content needed).
