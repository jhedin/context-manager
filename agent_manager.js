const { ClaudeAgent } = require('@anthropic-ai/claude-code');
const EventEmitter = require('events');
const { MultiSelect, Select } = require('enquirer');

// Configuration
const THRESHOLD_PERCENT = 0.8; // 80%
const MAX_CONTEXT_TOKENS = 250000;
const PLANNING_THRESHOLD = MAX_CONTEXT_TOKENS * THRESHOLD_PERCENT;

class ContextManager extends EventEmitter {
  constructor(agent) {
    super();
    this.agent = agent;
    this.isPlanningModeTriggered = false;
    this.setupListeners();
    this.registerCommands();
  }

  setupListeners() {
    this.agent.on('turn:end', async (turn) => {
      const { contextTokens } = turn.usage;
      console.log(`\n[Context Manager] Usage: ${contextTokens} / ${MAX_CONTEXT_TOKENS} tokens.`);

      // 1. AUTO-TRIGGER: Shift to Plan Mode when context is high
      if (contextTokens > PLANNING_THRESHOLD && !this.isPlanningModeTriggered) {
        await this.triggerPlanMode(contextTokens);
      }
    });
  }

  registerCommands() {
    // 2. MANUAL TRIGGER: Open the Pruning UI via slash command
    this.agent.registerCommand({
      name: 'compact-ui',
      description: 'Open the Interactive Context Management Dashboard to prune history.',
      handler: async () => {
        console.log(`\n[Context Manager] Opening Dashboard...`);
        await this.openPruningUI();
        console.log(`\n[Context Manager] Dashboard closed. Session resumed.`);
      }
    });
  }

  async triggerPlanMode(currentTokens) {
    this.isPlanningModeTriggered = true;
    const usagePercent = Math.round((currentTokens / MAX_CONTEXT_TOKENS) * 100);

    console.log(`[Context Manager] Threshold hit (${usagePercent}%). Forcing Plan Mode.`);

    // Programmatically set mode to 'plan'
    await this.agent.updateConfig({ permissionMode: 'plan' });

    // Inject Collaborative Instruction
    await this.agent.say(
      `We're nearing the end of the context limit (${usagePercent}% used). ` +
      `Let's pause for now, and come up with next steps for after compacting. ` +
      `Use EnterPlanMode to summarize our progress so we don't lose the thread after the reset.`
    );
  }

  // Segment history into logical topics with message metadata
  getTopics() {
    const history = this.agent.history;
    const topics = [];
    let currentTopic = { id: 1, name: "Initial Research", tokens: 0, messages: [] };

    history.forEach((msg, idx) => {
      const isPlanMode = msg.role === 'assistant' && 
                         msg.content && 
                         Array.isArray(msg.content) && 
                         msg.content.some(c => c.name === 'EnterPlanMode');

      if (isPlanMode) {
        topics.push(currentTopic);
        const planName = msg.content.find(c => c.name === 'EnterPlanMode')?.arguments?.objective || `Topic ${topics.length + 1}`;
        currentTopic = { id: topics.length + 1, name: planName, tokens: 0, messages: [] };
      }

      const msgTokens = JSON.stringify(msg).length / 4;
      currentTopic.tokens += msgTokens;
      currentTopic.messages.push({ ...msg, originalIndex: idx });
    });

    topics.push(currentTopic);
    return topics;
  }

  async openPruningUI() {
    let continueUI = true;
    while (continueUI) {
      const topics = this.getTopics();
      const mainPrompt = new Select({
        name: 'action',
        message: 'Context Management Dashboard',
        choices: [
          ...topics.map(t => ({ name: t.name, message: `${t.name} (${Math.round(t.tokens / 1024)} KB)`, value: t.id })),
          { role: 'separator' },
          { name: 'FINISH', message: 'Done (Resume Session)', value: 'finish' }
        ]
      });

      const choice = await mainPrompt.run();
      if (choice === 'FINISH') {
        continueUI = false;
      } else {
        const selectedTopic = topics.find(t => t.name === choice);
        await this.topicMenu(selectedTopic);
      }
    }
  }

  async topicMenu(topic) {
    const subPrompt = new Select({
      name: 'action',
      message: `Managing Topic: ${topic.name}`,
      choices: [
        { name: 'PRUNE_ALL', message: 'Prune Entire Topic' },
        { name: 'DIVE', message: 'Dive Deeper (Granular Pruning)' },
        { name: 'BACK', message: 'Back to Overview' }
      ]
    });

    const action = await subPrompt.run();
    if (action === 'PRUNE_ALL') {
      this.executePruning([topic.id]);
    } else if (action === 'DIVE') {
      await this.diveDeeperUI(topic);
    }
  }

  async diveDeeperUI(topic) {
    const candidates = [];
    topic.messages.forEach(msg => {
      if (msg.role === 'user' && msg.content && Array.isArray(msg.content)) {
        msg.content.forEach((c, cIdx) => {
          if (c.type === 'tool_result' && c.content && c.content.length > 500) {
            candidates.push({
              messageId: msg.uuid,
              contentIndex: cIdx,
              summary: `Tool Result: ${c.content.substring(0, 50)}... (${Math.round(c.content.length / 1024)} KB)`
            });
          }
        });
      }
    });

    if (candidates.length === 0) {
      console.log("No prunable tool results found in this topic.");
      return;
    }

    const divePrompt = new MultiSelect({
      name: 'selections',
      message: 'Select individual results to prune (Space to toggle, Enter to confirm)',
      choices: candidates.map((c, i) => ({ name: c.summary, value: i }))
    });

    const selections = await divePrompt.run();
    selections.forEach(selName => {
      const candidate = candidates.find(c => c.summary === selName);
      this.pruneIndividualResult(candidate);
    });
  }

  pruneIndividualResult(candidate) {
    const msg = this.agent.history.find(m => m.uuid === candidate.messageId);
    if (msg) {
      const toolContent = msg.content[candidate.contentIndex];
      const originalLength = toolContent.content.length;
      toolContent.content = `[Pruned: ${originalLength} characters of tool output]`;
      console.log(`[Pruning] Granularly pruned ${Math.round(originalLength / 1024)} KB.`);
    }
  }

  executePruning(topicIds) {
    const topics = this.getTopics();
    topicIds.forEach(id => {
      const topic = topics.find(t => t.id === id);
      if (topic) {
        topic.messages.forEach(topicMsg => {
          const actualMsg = this.agent.history.find(m => m.uuid === topicMsg.uuid);
          if (actualMsg && actualMsg.role === 'user' && Array.isArray(actualMsg.content)) {
            actualMsg.content.forEach(c => {
              if (c.type === 'tool_result' && c.content && c.content.length > 500) {
                c.content = `[Pruned: ${c.content.length} characters of tool output]`;
              }
            });
          }
        });
      }
    });
    console.log(`[Pruning] Topic-level pruning complete.`);
  }

  resetTrigger() {
    this.isPlanningModeTriggered = false;
  }
}

// Scaffolding for launch
async function startAgent() {
  const agent = new ClaudeAgent({ apiKeySource: 'none', permissionMode: 'not-set' });
  const manager = new ContextManager(agent);
  console.log("Context Manager Active.");
  console.log("- Auto-Trigger: High context shifts agent to Plan Mode.");
  console.log("- Manual-Trigger: Type /compact-ui to prune history.");
}

if (require.main === module) {
  startAgent().catch(console.error);
}
