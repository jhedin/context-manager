const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { CallToolRequestSchema, ListToolsRequestSchema } = require("@modelcontextprotocol/sdk/types.js");
const { MultiSelect, Select } = require('enquirer');
const fs = require('fs');

const server = new Server(
  { name: "context-manager-mcp", version: "1.1.0" },
  { capabilities: { tools: {} } }
);

const SESSION_PATH_FILE = '.claude/session_path.txt';
const STAGED_FUTURE_FILE = '.claude/staged_future.jsonl';

function getHistoryFromFile(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(l => l.trim());
  return lines.map(l => JSON.parse(l));
}

function verifyHistoryIntegrity(history) {
  const uuids = new Set(history.map(m => m.uuid));
  return history.every((msg, idx) => idx === 0 || (msg.parentUuid && uuids.has(msg.parentUuid)));
}

function getAutoSessionPath() {
  if (fs.existsSync(SESSION_PATH_FILE)) {
    return fs.readFileSync(SESSION_PATH_FILE, 'utf8').trim();
  }
  return null;
}

function unlinkMessagesFromDag(history, messageUuids) {
  const toRemove = new Set(messageUuids);
  history.forEach((msg) => {
    if (toRemove.has(msg.parentUuid)) {
      let currentParent = msg.parentUuid;
      let ancestor = null;
      while (currentParent) {
        const parentMsg = history.find(m => m.uuid === currentParent);
        if (!parentMsg || !toRemove.has(parentMsg.parentUuid)) {
          ancestor = parentMsg?.parentUuid;
          break;
        }
        currentParent = parentMsg.parentUuid;
      }
      if (ancestor) msg.parentUuid = ancestor;
    }
  });
  return history.filter(m => !toRemove.has(m.uuid));
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "open_pruning_dashboard",
      description: "Opens an interactive CLI dashboard to surgically bypass messages.",
      inputSchema: {
        type: "object",
        properties: { session_path: { type: "string" } }
      }
    },
    {
      name: "branch_session",
      description: "Truncates the session at a specific UUID, staging the future messages for later. (V0 Context Injection)",
      inputSchema: {
        type: "object",
        properties: {
          target_uuid: { type: "string", description: "The UUID to branch from (become the new leaf)" },
          session_path: { type: "string" }
        },
        required: ["target_uuid"]
      }
    },
    {
      name: "merge_future",
      description: "Re-appends the staged future onto the end of the current side-quest. (V0 Context Injection)",
      inputSchema: {
        type: "object",
        properties: { session_path: { type: "string" } }
      }
    }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  let filePath = request.params.arguments?.session_path || getAutoSessionPath();
  if (!filePath) return { content: [{ type: "text", text: "Error: Session path not found." }] };

  if (request.params.name === "open_pruning_dashboard") {
    let history = getHistoryFromFile(filePath);
    console.log(`\n--- Dashboard for: ${filePath} ---`);
    
    const prompt = new MultiSelect({
      name: 'selections',
      message: 'Select messages to BYPASS (Remove from DAG)',
      choices: history.slice(0, -5).map(m => ({ 
        name: `${m.message?.role || m.type}: ${JSON.stringify(m.message?.content || {}).substring(0, 60)}...`, 
        value: m.uuid 
      }))
    });

    const selections = await prompt.run();
    const newHistory = unlinkMessagesFromDag(history, selections);

    if (verifyHistoryIntegrity(newHistory)) {
      fs.writeFileSync(filePath, newHistory.map(h => JSON.stringify(h)).join('\n'));
      return { content: [{ type: "text", text: `Success: Bypassed ${selections.length} messages. RUN './self_resume.sh' NOW TO REFRESH.` }] };
    } else {
      return { content: [{ type: "text", text: "Error: Pruning would break DAG integrity. Aborted." }] };
    }
  }

  if (request.params.name === "branch_session") {
    const targetUuid = request.params.arguments.target_uuid;
    let history = getHistoryFromFile(filePath);
    
    const targetIndex = history.findIndex(m => m.uuid === targetUuid);
    if (targetIndex === -1) {
       return { content: [{ type: "text", text: `Error: UUID ${targetUuid} not found in history.` }] };
    }

    // Split DAG
    const newActiveHistory = history.slice(0, targetIndex + 1);
    const stagedFuture = history.slice(targetIndex + 1);

    if (stagedFuture.length === 0) {
      return { content: [{ type: "text", text: `Warning: UUID ${targetUuid} is already the latest message. Nothing to branch.` }] };
    }

    // Save
    fs.writeFileSync(STAGED_FUTURE_FILE, stagedFuture.map(h => JSON.stringify(h)).join('\n'));
    fs.writeFileSync(filePath, newActiveHistory.map(h => JSON.stringify(h)).join('\n'));

    return { content: [{ type: "text", text: `Success: Branched at ${targetUuid}. Staged ${stagedFuture.length} future messages. RUN './self_resume.sh' NOW TO REFRESH and begin the side-quest.` }] };
  }

  if (request.params.name === "merge_future") {
    if (!fs.existsSync(STAGED_FUTURE_FILE)) {
      return { content: [{ type: "text", text: "Error: No staged future found to merge." }] };
    }

    let activeHistory = getHistoryFromFile(filePath);
    let stagedFuture = getHistoryFromFile(STAGED_FUTURE_FILE);

    if (activeHistory.length === 0 || stagedFuture.length === 0) {
      return { content: [{ type: "text", text: "Error: Invalid history states for merge." }] };
    }

    // Re-parent the first message of the staged future to the LAST message of the active side-quest
    const newParentUuid = activeHistory[activeHistory.length - 1].uuid;
    console.log(`[Merge] Re-parenting future root ${stagedFuture[0].uuid} to new leaf ${newParentUuid}`);
    stagedFuture[0].parentUuid = newParentUuid;

    // Combine
    const mergedHistory = activeHistory.concat(stagedFuture);

    if (verifyHistoryIntegrity(mergedHistory)) {
      fs.writeFileSync(filePath, mergedHistory.map(h => JSON.stringify(h)).join('\n'));
      fs.unlinkSync(STAGED_FUTURE_FILE); // Clear stage
      return { content: [{ type: "text", text: `Success: Merged future back into session. RUN './self_resume.sh' NOW TO REFRESH and resume original timeline.` }] };
    } else {
       return { content: [{ type: "text", text: "Error: Merge failed DAG integrity check. Aborted." }] };
    }
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
