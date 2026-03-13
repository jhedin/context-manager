// test_suite.js
// A comprehensive test suite for the Context Manager logic

const THRESHOLD_PERCENT = 0.5;
const MAX_CONTEXT_TOKENS = 10000;
const PLANNING_THRESHOLD = MAX_CONTEXT_TOKENS * THRESHOLD_PERCENT;

// Mock message history with topics
const mockHistory = [
  { role: 'user', content: [{ type: 'text', text: 'Start feature 1' }], uuid: '1' },
  { role: 'assistant', content: [{ type: 'tool_use', name: 'EnterPlanMode', arguments: { objective: 'Feature 1 Design' } }], uuid: '2' },
  { role: 'user', content: [{ type: 'tool_result', content: 'A'.repeat(5000) }], uuid: '3' }, // Prunable
  { role: 'assistant', content: [{ type: 'text', text: 'Feature 1 done' }], uuid: '4' },
  { role: 'user', content: [{ type: 'text', text: 'Now Feature 2' }], uuid: '5' },
  { role: 'assistant', content: [{ type: 'tool_use', name: 'EnterPlanMode', arguments: { objective: 'Feature 2 Implementation' } }], uuid: '6' },
  { role: 'user', content: [{ type: 'tool_result', content: 'B'.repeat(1000) }], uuid: '7' }, // Prunable
];

class TestContextManager {
  constructor(agent) {
    this.agent = agent;
  }

  getTopics() {
    const history = this.agent.history;
    const topics = [];
    let currentTopic = { id: 1, name: "Initial Research", messages: [] };

    history.forEach((msg) => {
      const isPlanMode = msg.role === 'assistant' && 
                         msg.content && 
                         msg.content.some(c => c.name === 'EnterPlanMode');

      if (isPlanMode) {
        topics.push(currentTopic);
        const planName = msg.content.find(c => c.name === 'EnterPlanMode')?.arguments?.objective || `Topic ${topics.length + 1}`;
        currentTopic = { id: topics.length + 1, name: planName, messages: [] };
      }
      currentTopic.messages.push(msg);
    });
    topics.push(currentTopic);
    return topics;
  }

  executePruning(topicId) {
    const topics = this.getTopics();
    const topic = topics.find(t => t.id === topicId);
    if (!topic) return;

    topic.messages.forEach(topicMsg => {
      const actualMsg = this.agent.history.find(m => m.uuid === topicMsg.uuid);
      if (actualMsg && actualMsg.role === 'user') {
        actualMsg.content.forEach(c => {
          if (c.type === 'tool_result' && c.content.length > 500) {
            c.content = `[Pruned: ${c.content.length} characters]`;
          }
        });
      }
    });
  }
}

async function runTests() {
  console.log("--- Starting Context Manager Test Suite ---");

  const agent = { history: JSON.parse(JSON.stringify(mockHistory)) }; // Deep copy
  const manager = new TestContextManager(agent);

  // Test 1: Topic Segmentation
  const topics = manager.getTopics();
  console.log(`Test 1: Topic Segmentation - Count: ${topics.length} (Expected: 3)`);
  console.log(`- Topic 1: ${topics[0].name}`);
  console.log(`- Topic 2: ${topics[1].name}`);
  console.log(`- Topic 3: ${topics[2].name}`);

  // Test 2: Surgical Pruning (Topic 2)
  console.log("\nTest 2: Surgical Pruning (Topic 2)");
  const originalSize = JSON.stringify(agent.history).length;
  manager.executePruning(2); // Prune Topic 2 (Feature 1 Design)
  const newSize = JSON.stringify(agent.history).length;
  
  const prunedMsg = agent.history.find(m => m.uuid === '3');
  console.log(`- Original Size: ${originalSize} chars`);
  console.log(`- New Size: ${newSize} chars`);
  console.log(`- Pruned Message Content: ${prunedMsg.content[0].content}`);

  if (newSize < originalSize && prunedMsg.content[0].content.includes("[Pruned")) {
    console.log("\n[SUCCESS] Test Suite passed.");
  } else {
    console.log("\n[FAILURE] Test Suite failed.");
  }
}

runTests();
