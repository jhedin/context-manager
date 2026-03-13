// test_real_history.js
const fs = require('fs');
const readline = require('readline');

// Path to the real history file
const HISTORY_FILE = '/home/jhedin/.claude/projects/-home-jhedin-workspace-magpie-craft-cad/520bea9b-7f21-41fc-b2b6-3fa9aeb15604/subagents/agent-a269e8e.jsonl';

// Mocking the ContextManager getTopics logic
function getTopics(history) {
    const topics = [];
    let currentTopic = { id: 1, name: "Initial Discovery", tokens: 0, messages: [] };

    history.forEach((entry, idx) => {
        const msg = entry.message;
        if (!msg) return;

        // Boundary Logic: In real history, we look for major prompt shifts or EnterPlanMode
        const content = msg.content;
        const isPlanning = Array.isArray(content) && content.some(c => c.name === 'EnterPlanMode');
        
        // Also look for explicit "Now let me read..." style shifts in real data
        const isTopicShift = Array.isArray(content) && content.some(c => c.type === 'text' && c.text.toLowerCase().includes('now '));

        if (isPlanning || isTopicShift) {
            topics.push(currentTopic);
            const topicName = isPlanning ? 'Planning Phase' : (content.find(c => c.type === 'text')?.text || `Topic ${topics.length + 1}`);
            currentTopic = { id: topics.length + 1, name: topicName.substring(0, 30), tokens: 0, messages: [] };
        }

        const msgTokens = JSON.stringify(msg).length / 4;
        currentTopic.tokens += msgTokens;
        currentTopic.messages.push(entry);
    });

    topics.push(currentTopic);
    return topics;
}

async function runTest() {
    console.log(`--- Reading Real History: ${HISTORY_FILE} ---`);
    
    const lines = fs.readFileSync(HISTORY_FILE, 'utf8').split('\n').filter(l => l.trim());
    const history = lines.map(l => JSON.parse(l));

    console.log(`Total messages in history: ${history.length}`);

    const topics = getTopics(history);
    console.log(`\nDetected ${topics.length} Topic Segments:`);
    topics.forEach(t => {
        console.log(`- [${t.id}] ${t.name} (${Math.round(t.tokens / 1024)} KB)`);
    });

    // Let's look for "fat" tool results in Topic 1
    console.log(`\nAnalyzing Topic 1 for pruning candidates...`);
    const topic1 = topics[0];
    topic1.messages.forEach((entry, i) => {
        const msg = entry.message;
        if (msg && msg.role === 'user' && Array.isArray(msg.content)) {
            msg.content.forEach(c => {
                if (c.type === 'tool_result' && c.content.length > 1000) {
                    console.log(`  [FOUND] Large Tool Result: ${c.content.substring(0, 100)}... (${Math.round(c.content.length / 1024)} KB)`);
                }
            });
        }
    });
}

runTest().catch(console.error);
