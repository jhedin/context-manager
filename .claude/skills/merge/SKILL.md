---
name: merge
description: Merge staged future back after a branch session
user-invocable: true
---

# Merge Future

Re-append the staged future messages from a previous `/branch` operation, then erase the merge interaction itself.

## Steps

1. **Record the anchor UUID.** Use Bash to find the UUID of the last message before the `/merge` command:
   ```bash
   python3 -c "
   import json
   path = 'SESSION_PATH_HERE'
   entries = [json.loads(l) for l in open(path) if l.strip()]
   for i in range(len(entries)-1, -1, -1):
       e = entries[i]
       content = e.get('message',{}).get('content',[]) if isinstance(e.get('message'), dict) else []
       for b in content:
           if isinstance(b, dict) and b.get('type') == 'text' and '/merge' in b.get('text','')[:200]:
               for j in range(i-1, -1, -1):
                   if entries[j].get('uuid'):
                       print(f'ANCHOR={entries[j][\"uuid\"]}')
                       exit()
   "
   ```
2. Call `merge_future` from the context-manager MCP.
3. If it returns "No staged future to merge", tell the user there's nothing staged — they may not have run `/branch` first. Stop here.
4. On success, ask the user: "Erase the merge interaction from history? (Yes / No)"
5. If yes, call `forget_prune` with the anchor UUID from step 1. This must be the LAST tool call.
6. Tell the user: "Merged. **Type `/resume`** to reload with the full history."
