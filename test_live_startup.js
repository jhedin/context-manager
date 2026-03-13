const { ClaudeAgent } = require('@anthropic-ai/claude-code');
const { EventEmitter } = require('events');

// Simplified manager for the live test
class LiveTestManager {
  constructor(agent) {
    this.agent = agent;
    this.setup();
  }

  setup() {
    this.agent.on('turn:end', (turn) => {
      console.log(`[Live Test] Turn ended. Context used: ${turn.usage.contextTokens}`);
    });

    // Check if our command is registered
    const commands = this.agent.commands || []; 
    console.log(`[Live Test] Registered commands count: ${commands.length}`);
  }
}

async function runLiveTest() {
  console.log("--- Starting Live SDK Startup Test ---");
  try {
    const agent = new ClaudeAgent({ 
      apiKeySource: 'none', 
      permissionMode: 'not-set' 
    });

    const manager = new LiveTestManager(agent);
    
    console.log("[Live Test] Attempting a simple 'hello' turn...");
    
    // We use a internal method to send one turn instead of starting the full interactive run()
    // This varies by SDK version, but usually agent.say() or agent.next() works.
    await agent.say("Hello. This is a startup test. Please reply with 'READY'.");
    
    console.log("[SUCCESS] Live SDK session established.");
    process.exit(0);
  } catch (error) {
    console.error("[FAILURE] Live test failed:", error.message);
    process.exit(1);
  }
}

runLiveTest();
