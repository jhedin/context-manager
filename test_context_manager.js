// Mocking the ContextManager locally for the test
const THRESHOLD_PERCENT = 0.5; // Lower for testing
const MAX_CONTEXT_TOKENS = 10000;
const PLANNING_THRESHOLD = MAX_CONTEXT_TOKENS * THRESHOLD_PERCENT;

class ContextManagerMock {
  constructor(agent) {
    this.agent = agent;
    this.isPlanningModeTriggered = false;
  }

  async simulateTurn(tokens) {
    console.log(`[Test] Simulating turn with ${tokens} tokens...`);
    
    if (tokens > PLANNING_THRESHOLD && !this.isPlanningModeTriggered) {
      this.isPlanningModeTriggered = true;
      console.log(`[Test] Threshold hit! Forcing Plan Mode.`);
      
      const usagePercent = Math.round((tokens / MAX_CONTEXT_TOKENS) * 100);
      
      // Verification points
      // 1. Instructions check
      await this.agent.say(
        `We're nearing the end of the context limit (${usagePercent}% used). ` +
        `Let's pause for now, and come up with next steps for after compacting. ` +
        `Use EnterPlanMode to summarize our progress so we don't lose the thread after the reset.`
      );
      
      // 2. Mode check
      await this.agent.updateConfig({ permissionMode: 'plan' });
      console.log(`[Test] Agent config updated: permissionMode = ${this.agent.config.permissionMode}`);
    }
  }
}

async function runTest() {
  const mockAgent = {
    config: { permissionMode: 'not-set' },
    updateConfig: async (conf) => { mockAgent.config = { ...mockAgent.config, ...conf }; },
    say: async (msg) => { console.log(`[Mock Agent] Sent: "${msg}"`); }
  };

  const manager = new ContextManagerMock(mockAgent);

  // 1. Low usage (No trigger)
  await manager.simulateTurn(1000);
  console.log(`[Test Result] Triggered: ${manager.isPlanningModeTriggered} (Expected: false)`);

  // 2. High usage (Should trigger)
  await manager.simulateTurn(6000);
  console.log(`[Test Result] Triggered: ${manager.isPlanningModeTriggered} (Expected: true)`);
  console.log(`[Test Result] Final Mode: ${mockAgent.config.permissionMode} (Expected: plan)`);
}

runTest().catch(console.error);
