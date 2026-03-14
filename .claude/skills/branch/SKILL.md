---
name: branch
description: Rewind session to a topic for injecting new context
user-invocable: true
---

# Branch Session

Rewind the session to a specific topic so the user can add context (read files, create notes, do research) before merging the rest of the conversation back.

## Steps

1. Call `list_topics` from the context-manager MCP.
2. Present the topics to the user. Ask which topic they want to branch at (inject new context after).
3. Find the last message UUID of the chosen topic.
4. Call `branch_session` with that UUID.
5. Tell the user:
   - "Session branched. **Type `/resume`** to reload at that point."
   - "Do your research — read files, create notes, explore code. Avoid editing files that appear later in the conversation."
   - "When you're done, type **`/merge`** to stitch the rest of the conversation back."
