#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { v4: uuidv4 } = require('uuid');
const {
  buildUuidMap, findActiveTail, getActiveChainUuids, getTextContent,
  analyzeEntry, getTopics, scorePruningCandidates, checkForInflightWork,
  bypassTopic, restoreTopic, createDormantSummary, findDormantSummary,
  activateSummary, summarizeTopic, findTopicById, validateSessionPath,
  guardInflight
} = require('./context-mcp.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
  }
}

// --- Test helpers ---

function makeEntry(uuid, parentUuid, text, role = 'assistant') {
  return {
    uuid,
    parentUuid,
    type: role,
    sessionId: 'test-session',
    timestamp: new Date().toISOString(),
    message: {
      role,
      content: text ? [{ type: 'text', text }] : []
    }
  };
}

function makeChain(texts) {
  const entries = [];
  let prevUuid = null;
  for (const text of texts) {
    const uuid = uuidv4();
    entries.push(makeEntry(uuid, prevUuid, text));
    prevUuid = uuid;
  }
  return entries;
}

function getChainUuids(history) {
  return [...getActiveChainUuids(history)];
}

function assertChainLength(history, expected, msg) {
  const chain = getChainUuids(history);
  assert.strictEqual(chain.length, expected, `${msg}: expected chain ${expected}, got ${chain.length}`);
}

function assertNoOrphans(history, msg) {
  const uuids = new Set(history.filter(e => e.uuid).map(e => e.uuid));
  const activeUuids = getActiveChainUuids(history);
  for (const e of history) {
    if (e.parentUuid && activeUuids.has(e.uuid) && !uuids.has(e.parentUuid)) {
      assert.fail(`${msg}: orphan in active chain: ${e.uuid.slice(0,8)} parent=${e.parentUuid.slice(0,8)}`);
    }
  }
}

// =============================================================================
console.log('\nbuildUuidMap');
// =============================================================================

test('builds map from uuid to entry', () => {
  const entries = makeChain(['a', 'b', 'c']);
  const map = buildUuidMap(entries);
  assert.strictEqual(map.size, 3);
  assert.strictEqual(map.get(entries[1].uuid), entries[1]);
});

test('includes entries without uuid as undefined key', () => {
  const entries = [{ type: 'system' }, ...makeChain(['a'])];
  const map = buildUuidMap(entries);
  // buildUuidMap maps by uuid — entries without uuid get mapped under undefined
  assert(map.has(entries[1].uuid));
});

// =============================================================================
console.log('\nfindActiveTail');
// =============================================================================

test('returns last entry with no children', () => {
  const entries = makeChain(['a', 'b', 'c']);
  const tail = findActiveTail(entries);
  assert.strictEqual(tail.uuid, entries[2].uuid);
});

test('skips dormant summaries', () => {
  const entries = makeChain(['a', 'b']);
  entries.push({ uuid: uuidv4(), parentUuid: null, dormantSummaryFor: entries[0].uuid });
  const tail = findActiveTail(entries);
  assert.strictEqual(tail.uuid, entries[1].uuid);
});

// =============================================================================
console.log('\ngetActiveChainUuids');
// =============================================================================

test('returns all UUIDs in linear chain', () => {
  const entries = makeChain(['a', 'b', 'c', 'd']);
  const active = getActiveChainUuids(entries);
  assert.strictEqual(active.size, 4);
  for (const e of entries) assert(active.has(e.uuid));
});

test('chain follows the path to the tail', () => {
  const entries = makeChain(['a', 'b', 'c']);
  // Add an orphan branching off entry 0 — both entry[1] and orphan are children of entry[0]
  // findActiveTail picks orphan (last entry with no children), so chain is: entry[0] → orphan
  // This is expected DAG behavior — the "active chain" is the path to the tail
  const orphan = makeEntry(uuidv4(), entries[0].uuid, 'orphan');
  entries.push(orphan);
  const active = getActiveChainUuids(entries);
  assert(active.has(entries[0].uuid), 'root in chain');
  assert(active.has(orphan.uuid), 'tail (orphan) in chain');
});

// =============================================================================
console.log('\ngetTextContent');
// =============================================================================

test('extracts text from entry', () => {
  const entry = makeEntry('a', null, 'hello world');
  assert.strictEqual(getTextContent(entry), 'hello world');
});

test('returns empty string for no content', () => {
  const entry = { uuid: 'a', message: {} };
  assert.strictEqual(getTextContent(entry), '');
});

// =============================================================================
console.log('\ngetTopics');
// =============================================================================

test('splits on "Now " prefix', () => {
  const entries = makeChain(['Initial setup', 'doing stuff', 'Now fix the bug', 'fixed it']);
  const topics = getTopics(entries);
  assert.strictEqual(topics.length, 2);
  assert.strictEqual(topics[1].messages.length, 2);
});

test('splits on "Next " prefix', () => {
  const entries = makeChain(['start', 'Next add tests', 'test code']);
  const topics = getTopics(entries);
  assert.strictEqual(topics.length, 2);
});

test('skips dormant summary entries', () => {
  const entries = makeChain(['start', 'Now do work', 'done']);
  entries.push({ uuid: uuidv4(), parentUuid: null, dormantSummaryFor: entries[1].uuid,
    message: { role: 'assistant', content: [{ type: 'text', text: 'dormant' }] } });
  const topics = getTopics(entries);
  // Dormant should not create its own topic
  const allMsgs = topics.flatMap(t => t.messages);
  assert(!allMsgs.some(m => m.text === 'dormant'));
});

test('marks orphaned topics after bypass', () => {
  // Need a topic in the middle (not the last) so bypass has something to reparent
  const entries = makeChain(['start', 'Now do work', 'work done', 'Now finish up', 'finished']);
  const topics = getTopics(entries);
  const topic = topics.find(t => t.name.includes('do work'));
  const bypassed = bypassTopic(entries, topic);
  const topics2 = getTopics(bypassed);
  const orphanTopic = topics2.find(t => t.name.includes('do work'));
  assert(orphanTopic, 'orphaned topic should exist');
  assert(orphanTopic.isOrphan, 'topic should be marked as orphan');
});

// =============================================================================
console.log('\nscorePruningCandidates');
// =============================================================================

test('orphans score 0', () => {
  const entries = makeChain(['start', 'Now work']);
  const orphan = makeEntry(uuidv4(), 'gone', 'Now orphan');
  entries.push(orphan);
  const topics = getTopics(entries);
  const scored = scorePruningCandidates(topics);
  const orphanScored = scored.find(t => t.messages.some(m => m.text === 'Now orphan'));
  assert.strictEqual(orphanScored.pruneScore, 0);
});

test('summaries score 0', () => {
  const entries = makeChain(['start', '[SUMMARY of "test" — 5 messages condensed]\n\nSummary text']);
  const topics = getTopics(entries);
  const scored = scorePruningCandidates(topics);
  const summaryTopic = scored.find(t => t.messages.some(m => m.text?.startsWith('[SUMMARY of')));
  if (summaryTopic) assert.strictEqual(summaryTopic.pruneScore, 0);
});

// =============================================================================
console.log('\nbypassTopic');
// =============================================================================

test('removes topic from active chain', () => {
  const entries = makeChain(['start', 'Now topic A', 'A work', 'Now topic B', 'B work']);
  const topics = getTopics(entries);
  const topicA = topics.find(t => t.name.includes('topic A'));
  const result = bypassTopic(entries, topicA);
  assertChainLength(result, 3, 'after bypass'); // start + topicB + B work
  assertNoOrphans(result, 'after bypass');
});

test('bypass is reversible via restore', () => {
  const entries = makeChain(['start', 'Now topic A', 'A work', 'Now topic B', 'B work']);
  const chainBefore = getActiveChainUuids(entries).size;

  const topics = getTopics(entries);
  const topicA = topics.find(t => t.name.includes('topic A'));
  const bypassed = bypassTopic(entries, topicA);

  const topics2 = getTopics(bypassed);
  const topicA2 = topics2.find(t => t.name.includes('topic A'));
  assert(topicA2.isOrphan, 'topic should be orphaned after bypass');

  const restored = restoreTopic(bypassed, topicA2);
  assert(!restored.error, 'restore should not return error');
  assertChainLength(restored, chainBefore, 'after restore');
  assertNoOrphans(restored, 'after restore');
});

test('bypass middle topic preserves chain integrity', () => {
  const entries = makeChain([
    'start', 'Now A', 'A1', 'A2', 'Now B', 'B1', 'Now C', 'C1'
  ]);
  const topics = getTopics(entries);
  const topicB = topics.find(t => t.name.includes(' B'));
  const result = bypassTopic(entries, topicB);
  assertNoOrphans(result, 'bypass middle');
  // C should chain to A's last message
  const active = getActiveChainUuids(result);
  assert(active.has(entries[0].uuid), 'start in chain');
  assert(active.has(entries[7].uuid), 'C1 in chain');
});

// =============================================================================
console.log('\nrestoreTopic');
// =============================================================================

test('errors on non-orphaned topic', () => {
  const entries = makeChain(['start', 'Now work', 'done']);
  const topics = getTopics(entries);
  const topic = topics.find(t => !t.isOrphan && t.name.includes('work'));
  if (topic) {
    const result = restoreTopic(entries, topic);
    assert(result.error, 'should error on non-orphan');
  }
});

// =============================================================================
console.log('\ndormant summaries');
// =============================================================================

test('createDormantSummary appends without affecting chain', () => {
  const entries = makeChain(['start', 'Now work', 'done']);
  const chainBefore = getActiveChainUuids(entries).size;
  const topics = getTopics(entries);
  const topic = topics.find(t => t.name.includes('work'));

  const result = createDormantSummary(entries, topic, 'Summary text');
  // Now creates 2 entries (assistant + result pair)
  assert.strictEqual(result.length, entries.length + 2);
  assertChainLength(result, chainBefore, 'after dormant create');

  const assistantEntry = result[result.length - 2];
  const resultEntry = result[result.length - 1];
  assert.strictEqual(assistantEntry.dormantSummaryFor, topic.id);
  assert.strictEqual(assistantEntry.parentUuid, null);
  assert.strictEqual(resultEntry.dormantSummaryFor, topic.id);
  assert.strictEqual(resultEntry.parentUuid, assistantEntry.uuid);
});

test('findDormantSummary finds by exact ID', () => {
  const entries = makeChain(['start', 'Now work']);
  const topics = getTopics(entries);
  const topic = topics.find(t => t.name.includes('work'));

  const withDormant = createDormantSummary(entries, topic, 'test');
  const found = findDormantSummary(withDormant, topic.id);
  assert(found, 'should find dormant');
  assert(found.assistantEntry, 'should have assistantEntry');
  assert.strictEqual(found.assistantEntry.dormantSummaryFor, topic.id);
  assert(found.resultEntry, 'should have resultEntry');
});

test('findDormantSummary returns null when none exists', () => {
  const entries = makeChain(['start', 'Now work']);
  const found = findDormantSummary(entries, 'nonexistent');
  assert.strictEqual(found, null);
});

test('activateSummary links dormant pair into chain', () => {
  const entries = makeChain(['start', 'Now work', 'w1', 'Now after', 'a1']);
  const topics = getTopics(entries);
  const topic = topics.find(t => t.name.includes('work'));

  const withDormant = createDormantSummary(entries, topic, 'Summary');
  const resultEntry = withDormant[withDormant.length - 1];
  const assistantEntry = withDormant[withDormant.length - 2];
  const dormantPair = { assistantEntry, resultEntry };

  const activated = activateSummary(withDormant, topic, dormantPair);
  const activeAfter = getActiveChainUuids(activated);

  // Both pair entries should be in chain now
  assert(activeAfter.has(assistantEntry.uuid), 'assistant entry should be in active chain');
  assert(activeAfter.has(resultEntry.uuid), 'result entry should be in active chain');
  // Topic messages should be orphaned
  assert(!activeAfter.has(topic.id), 'topic first msg should be orphaned');
  assertNoOrphans(activated, 'after activate');
});

test('summarizeTopic uses dormant if available', () => {
  const entries = makeChain(['start', 'Now work', 'w1', 'Now after', 'a1']);
  const topics = getTopics(entries);
  const topic = topics.find(t => t.name.includes('work'));

  // Pre-create dormant
  const withDormant = createDormantSummary(entries, topic, 'Pre-built summary');
  const resultEntryUuid = withDormant[withDormant.length - 1].uuid;
  const assistantEntryUuid = withDormant[withDormant.length - 2].uuid;

  // summarizeTopic should activate the dormant, not create a new one
  const topics2 = getTopics(withDormant);
  const topic2 = topics2.find(t => t.name.includes('work'));
  const result = summarizeTopic(withDormant, topic2, 'This text should be ignored');

  const activeAfter = getActiveChainUuids(result);
  assert(activeAfter.has(assistantEntryUuid), 'assistant entry should be active');
  assert(activeAfter.has(resultEntryUuid), 'result entry should be active');
  assertNoOrphans(result, 'after summarize with dormant');
});

test('summarizeTopic creates inline when no dormant', () => {
  const entries = makeChain(['start', 'Now work', 'w1', 'Now after', 'a1']);
  const topics = getTopics(entries);
  const topic = topics.find(t => t.name.includes('work'));

  const result = summarizeTopic(entries, topic, 'Inline summary');
  assert.strictEqual(result.length, entries.length + 2); // +2 for subagent pair
  assertNoOrphans(result, 'after inline summarize');
  // Result entry (tail of pair) should be in chain
  const resultEntry = result.find(e =>
    e.message?.content?.some(b =>
      b.type === 'tool_result' &&
      Array.isArray(b.content) &&
      b.content.some(c => c.type === 'text' && c.text?.includes('Inline summary'))
    )
  );
  assert(resultEntry, 'result entry should exist');
  const active = getActiveChainUuids(result);
  assert(active.has(resultEntry.uuid), 'result entry should be in active chain');
});

// =============================================================================
console.log('\nfindTopicById');
// =============================================================================

test('finds by exact ID', () => {
  const entries = makeChain(['start', 'Now work']);
  const topics = getTopics(entries);
  const { topic } = findTopicById(topics, topics[1].id);
  assert.strictEqual(topic.id, topics[1].id);
});

test('finds by 8+ char prefix', () => {
  const entries = makeChain(['start', 'Now work']);
  const topics = getTopics(entries);
  const prefix = topics[1].id.substring(0, 10);
  const { topic } = findTopicById(topics, prefix);
  assert.strictEqual(topic.id, topics[1].id);
});

test('rejects prefix shorter than 8 chars', () => {
  const entries = makeChain(['start', 'Now work']);
  const topics = getTopics(entries);
  const { error } = findTopicById(topics, 'abc');
  assert(error, 'should error on short prefix');
  assert(error.includes('too short'));
});

test('errors on not found', () => {
  const entries = makeChain(['start']);
  const topics = getTopics(entries);
  const { error } = findTopicById(topics, 'aaaaaaaa-bbbb');
  assert(error, 'should error');
  assert(error.includes('not found'));
});

// =============================================================================
console.log('\nvalidateSessionPath');
// =============================================================================

test('accepts .jsonl in .claude directory', () => {
  const home = process.env.HOME || '';
  const err = validateSessionPath(`${home}/.claude/projects/test/session.jsonl`);
  assert.strictEqual(err, null);
});

test('rejects non-.jsonl files', () => {
  const err = validateSessionPath('/tmp/evil.txt');
  assert(err, 'should reject non-jsonl');
  assert(err.includes('.jsonl'));
});

test('rejects files outside .claude', () => {
  const err = validateSessionPath('/tmp/evil.jsonl');
  assert(err, 'should reject outside .claude');
});

test('accepts test_session.jsonl', () => {
  const err = validateSessionPath('test_session.jsonl');
  assert.strictEqual(err, null);
});

// =============================================================================
console.log('\ncheckForInflightWork');
// =============================================================================

test('detects pending tool_use', () => {
  const entries = [
    makeEntry(uuidv4(), null, ''),
  ];
  entries[0].message.content = [
    { type: 'tool_use', id: 'tool-1', name: 'Bash', input: {} }
  ];
  const { pendingTools } = checkForInflightWork(entries);
  assert.strictEqual(pendingTools.size, 1);
});

test('resolved tool_use is not pending', () => {
  const e1 = makeEntry(uuidv4(), null, '');
  e1.message.content = [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: {} }];
  const e2 = makeEntry(uuidv4(), e1.uuid, '');
  e2.message.role = 'user';
  e2.message.content = [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }];
  const { pendingTools } = checkForInflightWork([e1, e2]);
  assert.strictEqual(pendingTools.size, 0);
});

// =============================================================================
console.log('\nguardInflight');
// =============================================================================

test('allows writes with no pending work', () => {
  const entries = makeChain(['start', 'Now work', 'done']);
  const result = guardInflight(entries);
  assert.strictEqual(result, null, 'should allow');
});

test('blocks on external pending tool', () => {
  const entries = makeChain(['start']);
  entries[0].message.content = [
    { type: 'text', text: 'start' },
    { type: 'tool_use', id: 'tool-ext', name: 'Bash', input: {} }
  ];
  const result = guardInflight(entries);
  assert(result, 'should block');
  assert(result.includes('in-flight'));
});

test('allows own MCP tools as pending', () => {
  const entries = makeChain(['start']);
  entries[0].message.content = [
    { type: 'text', text: 'start' },
    { type: 'tool_use', id: 'tool-own', name: 'mcp__context-manager__list_topics', input: {} }
  ];
  const result = guardInflight(entries);
  assert.strictEqual(result, null, 'should allow own tools');
});

// =============================================================================
console.log('\nround-trip: bypass → restore chain integrity');
// =============================================================================

test('multiple bypasses and restores maintain chain', () => {
  const entries = makeChain([
    'start', 'Now do A work', 'A1', 'Now do B work', 'B1', 'B2', 'Now do C work', 'C1', 'Now do D work', 'D1'
  ]);
  const chainBefore = getActiveChainUuids(entries).size;

  // Save topic IDs before any mutations
  let topics = getTopics(entries);
  const topicBId = topics.find(t => t.name.includes('do B')).id;
  const topicCId = topics.find(t => t.name.includes('do C')).id;

  // Bypass B
  let topicB = topics.find(t => t.id === topicBId);
  let result = bypassTopic(entries, topicB);
  assertNoOrphans(result, 'after bypass B');

  // Bypass C
  topics = getTopics(result);
  let topicC = topics.find(t => t.id === topicCId);
  result = bypassTopic(result, topicC);
  assertNoOrphans(result, 'after bypass C');

  // Restore B
  topics = getTopics(result);
  topicB = topics.find(t => t.id === topicBId && t.isOrphan);
  assert(topicB, 'B should be orphaned');
  result = restoreTopic(result, topicB);
  assert(!result.error);
  assertNoOrphans(result, 'after restore B');

  // Restore C
  topics = getTopics(result);
  topicC = topics.find(t => t.id === topicCId && t.isOrphan);
  assert(topicC, 'C should be orphaned');
  result = restoreTopic(result, topicC);
  assert(!result.error);
  assertNoOrphans(result, 'after restore C');

  assertChainLength(result, chainBefore, 'full round-trip');
});

test('summarize → restore round-trip', () => {
  const entries = makeChain([
    'start', 'Now topic X', 'X work 1', 'X work 2', 'Now after X', 'done'
  ]);
  const chainBefore = getActiveChainUuids(entries).size;

  // Summarize
  let topics = getTopics(entries);
  let topicX = topics.find(t => t.name.includes('topic X'));
  let result = summarizeTopic(entries, topicX, 'X was summarized');
  assertNoOrphans(result, 'after summarize');

  // Restore
  topics = getTopics(result);
  topicX = topics.find(t => t.name.includes('topic X') && t.isOrphan);
  assert(topicX, 'original topic should be orphaned');
  result = restoreTopic(result, topicX);
  assert(!result.error, `restore failed: ${result.error}`);
  assertNoOrphans(result, 'after restore');
  assertChainLength(result, chainBefore, 'summarize→restore round-trip');
});

// =============================================================================
// Summary
// =============================================================================

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
