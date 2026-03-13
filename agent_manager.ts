import { ClaudeAgent } from '@anthropic-ai/claude-code';
import { EventEmitter } from 'events';

// Configuration
const THRESHOLD_PERCENT = 0.8; // 80%
const MAX_CONTEXT_TOKENS = 250000;
const PLANNING_THRESHOLD = MAX_CONTEXT_TOKENS * THRESHOLD_PERCENT;

class ContextManager extends EventEmitter {
  private agent: any;
  private isPlanningModeTriggered: boolean = false;

  constructor(agent: any) {
    super();
    this.agent = agent;
    this.setupListeners();
  }

  private setupListeners() {
    // 1. Monitor Context after every turn
    this.agent.on('turn:end', async (turn: any) => {
      const { contextTokens } = turn.usage;
      console.log(`[Context Manager] Usage: ${contextTokens} / ${MAX_CONTEXT_TOKENS} tokens.`);

      if (contextTokens > PLANNING_THRESHOLD && !this.isPlanningModeTriggered) {
        await this.triggerPlanMode(contextTokens);
      }
    });

    // 2. Tool Guard (State Machine logic)
    // If we're in "Planning Required" state, we can add extra logic here
    // to reject non-planning tools if needed.
  }

  private async triggerPlanMode(currentTokens: number) {
    this.isPlanningModeTriggered = true;
    const usagePercent = Math.round((currentTokens / MAX_CONTEXT_TOKENS) * 100);

    console.log(`[Context Manager] Threshold hit (${usagePercent}%). Forcing Plan Mode.`);

    // 1. Programmatically set mode to 'plan' (Restricts to read-only tools)
    await this.agent.updateConfig({ permissionMode: 'plan' });

    // 2. Inject Collaborative Instruction
    // This tells the agent WHY we are pausing and what the next step is.
    await this.agent.say(
      `We're nearing the end of the context limit (${usagePercent}% used). ` +
      `Let's pause for now, and come up with next steps for after compacting. ` +
      `Use EnterPlanMode to summarize our progress so we don't lose the thread after the reset.`
    );
  }

  public resetTrigger() {
    this.isPlanningModeTriggered = false;
  }
}

// Example usage / Scaffolding
async function startAgent() {
  const agent = new ClaudeAgent({
    apiKeySource: 'none', // Uses existing OAuth session
    permissionMode: 'not-set', // Starts in Interactive mode
  });

  const manager = new ContextManager(agent);

  console.log("Context Manager Active. Monitoring session...");
  // agent.run() would be called here to start the interactive session
}

if (require.main === module) {
  startAgent().catch(console.error);
}
