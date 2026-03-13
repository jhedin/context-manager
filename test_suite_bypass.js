// test_suite_bypass.js
const { EventEmitter } = require('events');

// Mock History with UUID chain
const mockHistory = [
  { uuid: 'ROOT', parentUuid: null, role: 'user', content: [{ type: 'text', text: 'Prompt' }] },
  { uuid: 'MSG_1', parentUuid: 'ROOT', role: 'assistant', content: [{ type: 'text', text: 'Thought 1' }] },
  { uuid: 'MSG_2', parentUuid: 'MSG_1', role: 'user', content: [{ type: 'tool_result', content: 'Big Log' }] }, // BYPASS TARGET
  { uuid: 'MSG_3', parentUuid: 'MSG_2', role: 'assistant', content: [{ type: 'text', text: 'Thought 2' }] },
  { uuid: 'MSG_4', parentUuid: 'MSG_3', role: 'user', content: [{ type: 'text', text: 'Final Prompt' }] },
];

class ContextManagerTest {
  constructor(agent) {
    this.agent = agent;
  }

  unlinkMessagesFromDag(messageUuids) {
    const history = this.agent.history;
    const toRemove = new Set(messageUuids);

    history.forEach((msg) => {
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
          console.log(`[Test] Re-parenting ${msg.uuid} to ancestor ${ancestor}`);
          msg.parentUuid = ancestor;
        }
      }
    });

    this.agent.history = history.filter(m => !toRemove.has(m.uuid));
  }

  verifyHistoryIntegrity() {
    const history = this.agent.history;
    const uuids = new Set(history.map(m => m.uuid));
    let errors = [];

    history.forEach((msg, idx) => {
      if (idx > 0 && (!msg.parentUuid || !uuids.has(msg.parentUuid))) {
        errors.push(`Orphan at ${msg.uuid}: parent ${msg.parentUuid} missing.`);
      }
    });

    return errors.length === 0;
  }
}

async function runTests() {
  console.log("--- Starting DAG Bypass Test Suite ---");

  const agent = { history: JSON.parse(JSON.stringify(mockHistory)) };
  const manager = new ContextManagerTest(agent);

  // 1. Initial State
  console.log(`Initial Integrity: ${manager.verifyHistoryIntegrity()} (Expected: true)`);
  console.log(`Initial History Length: ${agent.history.length}`);

  // 2. Perform Bypass (Remove MSG_2)
  console.log("\nAction: Bypassing MSG_2 (The Big Log)...");
  manager.unlinkMessagesFromDag(['MSG_2']);

  // 3. Verify Re-parenting
  const msg3 = agent.history.find(m => m.uuid === 'MSG_3');
  console.log(`MSG_3 New Parent: ${msg3.parentUuid} (Expected: MSG_1)`);

  // 4. Verify Final Integrity
  const isHealthy = manager.verifyHistoryIntegrity();
  console.log(`Final Integrity: ${isHealthy} (Expected: true)`);
  console.log(`Final History Length: ${agent.history.length} (Expected: 4)`);

  if (isHealthy && msg3.parentUuid === 'MSG_1' && agent.history.length === 4) {
    console.log("\n[SUCCESS] DAG Bypass logic verified.");
  } else {
    console.log("\n[FAILURE] DAG Bypass logic failed.");
  }
}

runTests();
