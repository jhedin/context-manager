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

  // Segment history into logical topics with smart naming
  getTopics() {
    const history = this.agent.history;
    const topics = [];
    let currentTopic = { id: 1, name: "[Research] Initial Context", tokens: 0, messages: [] };

    const categorize = (text, tools = []) => {
      const lower = text.toLowerCase();
      if (tools.some(t => t.name === 'EnterPlanMode') || lower.includes('plan')) return 'Plan';
      if (lower.includes('review') || lower.includes('audit')) return 'Review';

      const isVerification = lower.includes('test') || lower.includes('verify') || lower.includes('run');
      const isAct = lower.includes('fix') || lower.includes('update') || lower.includes('implement');

      if (isVerification && isAct) return 'Iteration Loop';
      if (isVerification) return 'Verification';
      if (isAct) return 'Act';
      if (lower.includes('read') || lower.includes('check') || lower.includes('explore')) return 'Research';
      return 'Research';
    };

    let lastCategory = '';
    let iterationCount = 0;

    history.forEach((msg, idx) => {
      const content = Array.isArray(msg.content) ? msg.content : [];
      const toolUses = content.filter(c => c.type === 'tool_use');
      const textContent = content.find(c => c.type === 'text')?.text || '';

      const category = categorize(textContent, toolUses);
      const isTopicShift = textContent.toLowerCase().startsWith('now ') || 
                           textContent.toLowerCase().startsWith('next ') ||
                           toolUses.some(t => t.name === 'EnterPlanMode');

      if (lastCategory === 'Verification' && category === 'Act') {
        iterationCount++;
      }

      if (isTopicShift && idx > 0) {
        topics.push(currentTopic);
        let label = `[${category}]`;
        if (iterationCount > 0 && (category === 'Act' || category === 'Verification')) {
          label = `[Iteration ${iterationCount}: ${category}]`;
        }

        const shortName = textContent.split(/[.!?]/)[0].substring(0, 40);
        currentTopic = { id: topics.length + 1, name: `${label} ${shortName}`, tokens: 0, messages: [] };
        lastCategory = category;
      }
      const msgTokens = JSON.parse(JSON.stringify(msg)).length / 4;
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
        { name: 'BYPASS_ALL', message: 'Bypass Entire Topic (Remove from DAG, keep in file)' },
        { name: 'DIVE', message: 'Dive Deeper (Selective Bypass)' },
        { name: 'BACK', message: 'Back to Overview' }
      ]
    });

    const action = await subPrompt.run();
    if (action === 'BYPASS_ALL') {
      const uuids = topic.messages.map(m => m.uuid);
      this.unlinkMessagesFromDag(uuids);
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
      console.log("No bypass candidates found in this topic.");
      return;
    }

    const divePrompt = new MultiSelect({
      name: 'selections',
      message: 'Select items to BYPASS (Remove from DAG, keep in file)',
      choices: candidates.map((c, i) => ({ name: c.summary, value: i }))
    });

    const selections = await divePrompt.run();
    const uuidsToBypass = selections.map(selName => {
      const candidate = candidates.find(c => c.summary === selName);
      return candidate.messageId;
    });

    if (uuidsToBypass.length > 0) {
      this.unlinkMessagesFromDag(uuidsToBypass);
      console.log(`[Pruning] Bypassed ${uuidsToBypass.length} messages.`);
    }
  }

  unlinkMessagesFromDag(messageUuids) {
    const history = this.agent.history;
    const toRemove = new Set(messageUuids);

    history.forEach((msg, idx) => {
      if (toRemove.has(msg.parentUuid)) {
        let currentParent = msg.parentUuid;
        let ancestor = null;

        while (currentParent) {
          const parentMsg = history.find(m => m.uuid === currentParent);
          if (!parentMsg) break;
          if (!toRemove.has(parentMsg.parentUuid)) {
            ancestor = parentMsg.parentUuid;
            break;
          }
          currentParent = parentMsg.parentUuid;
        }

        if (ancestor) {
          console.log(`[DAG Bypass] Re-parenting ${msg.uuid.substring(0,8)} to grandparent ${ancestor.substring(0,8)}`);
          msg.parentUuid = ancestor;
        }
      }
    });

    this.agent.history = history.filter(m => !toRemove.has(m.uuid));
    this.verifyHistoryIntegrity();
  }

  verifyHistoryIntegrity() {
    const history = this.agent.history;
    const uuids = new Set(history.map(m => m.uuid));
    let errors = [];

    history.forEach((msg, idx) => {
      if (idx > 0 && (!msg.parentUuid || !uuids.has(msg.parentUuid))) {
        errors.push(`Orphan message at index ${idx}: parentUuid ${msg.parentUuid} not found.`);
      }
    });

    if (errors.length > 0) {
      console.error("[Integrity Error] DAG broken:", errors);
      return false;
    }
    console.log("[Integrity Check] DAG is healthy.");
    return true;
  }

  resetTrigger() {
    this.isPlanningModeTriggered = false;
  }
}

async function startAgent() {
  const agent = new ClaudeAgent({ 
    apiKeySource: 'none', 
    permissionMode: 'not-set' 
  });

  const manager = new ContextManager(agent);
  
  console.log("\n--- Custom Context Manager V1 ---");
  console.log("Monitoring session usage...");
  console.log("- Auto-Trigger: Shift to Plan Mode at 80% usage.");
  console.log("- Manual Command: Type /compact-ui to prune history.\n");

  await agent.run();
}

if (require.main === module) {
  startAgent().catch(console.error);
}
