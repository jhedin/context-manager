#!/usr/bin/env node
/**
 * test-hooks.js — Direct stdin-piping tests for hook scripts.
 *
 * Tests hooks in isolation by piping crafted JSON payloads to stdin,
 * then asserting on exit code and filesystem side effects.
 * No Claude Code or LLM involvement — fast and deterministic.
 *
 * Run: node test-hooks.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const assert = require('assert');
const { v4: uuidv4 } = require('uuid');

const CWD = __dirname;
const CLAUDE_DIR = path.join(CWD, '.claude');
const HOOKS_LOG_DIR = path.join(CLAUDE_DIR, 'hooks');
const BACKUP_DIR = path.join(CLAUDE_DIR, 'backups');
const REPARENT_MARKER = path.join(CLAUDE_DIR, 'pending_reparent.json');

let passed = 0;
let failed = 0;

function pass(name) { passed++; console.log(`  ✓ ${name}`); }
function fail(name, err) { failed++; console.log(`  ✗ ${name}\n    ${err}`); }

// Ensure required directories exist
for (const dir of [CLAUDE_DIR, HOOKS_LOG_DIR, BACKUP_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * Pipe JSON payload to a hook script on stdin.
 * Returns { exitCode, stdout, stderr }.
 */
function runHook(hookPath, payload) {
  const result = spawnSync('node', [hookPath], {
    input: JSON.stringify(payload),
    cwd: CWD,
    encoding: 'utf8',
    timeout: 10000,
  });
  return {
    exitCode: result.status ?? 0,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

/**
 * Create a minimal session JSONL with N entries.
 * Returns { filePath, entries, uuids }.
 */
function createTempSession(entryCount = 3) {
  const filePath = path.join(CLAUDE_DIR, `test-hook-session-${Date.now()}.jsonl`);
  const uuids = Array.from({ length: entryCount }, () => uuidv4());
  const entries = uuids.map((uuid, i) => ({
    uuid,
    parentUuid: i === 0 ? null : uuids[i - 1],
    type: i % 2 === 0 ? 'assistant' : 'user',
    sessionId: 'test-session',
    timestamp: new Date().toISOString(),
    message: {
      role: i % 2 === 0 ? 'assistant' : 'user',
      content: [{ type: 'text', text: `Message ${i}` }],
    },
  }));
  fs.writeFileSync(filePath, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  return { filePath, entries, uuids };
}

function readSessionEntries(filePath) {
  return fs.readFileSync(filePath, 'utf8')
    .split('\n').filter(l => l.trim())
    .map(l => JSON.parse(l));
}

// =============================================================================
// stop.js tests
// =============================================================================

function testStopNoMarker() {
  const name = 'stop.js: exits 0 with no reparent marker, no session mutation';
  const { filePath, entries } = createTempSession(4);
  // Ensure no marker
  try { fs.unlinkSync(REPARENT_MARKER); } catch (_) {}

  // Write minimal usage to session so hook doesn't short-circuit
  const lastEntry = entries[entries.length - 1];
  lastEntry.message = {
    role: 'assistant',
    model: 'claude-sonnet-4-6',
    usage: { input_tokens: 1000, output_tokens: 100 },
    content: [],
  };
  fs.writeFileSync(filePath, entries.map(e => JSON.stringify(e)).join('\n') + '\n');

  const payload = {
    session_id: 'test-session',
    transcript_path: filePath,
    stop_hook_active: false,
  };

  const { exitCode } = runHook(path.join(CWD, 'hooks/stop.js'), payload);

  try {
    assert.strictEqual(exitCode, 0, `expected exit 0, got ${exitCode}`);
    // Session should not be mutated (no reparent needed)
    const after = readSessionEntries(filePath);
    assert.strictEqual(after.length, entries.length, 'session entry count changed unexpectedly');
    pass(name);
  } catch (err) {
    fail(name, err.message);
  } finally {
    try { fs.unlinkSync(filePath); } catch (_) {}
  }
}

function testStopWithMarkerReparents() {
  const name = 'stop.js: with reparent marker, reparents orphaned entries';
  const { filePath, entries, uuids } = createTempSession(5);

  // Simulate forget_prune: remove entries 2 and 3, entry 4 has stale parentUuid
  const anchorUuid = uuids[1];
  const removedUuid = uuids[2];

  // Rewrite session: only entries 0, 1, 4 — entry 4 still has parentUuid=uuids[3] (missing)
  const kept = [entries[0], entries[1], { ...entries[4], parentUuid: uuids[3] }];
  fs.writeFileSync(filePath, kept.map(e => JSON.stringify(e)).join('\n') + '\n');

  // Write marker
  fs.writeFileSync(REPARENT_MARKER, JSON.stringify({ anchorUuid, sessionPath: filePath }));

  const payload = {
    session_id: 'test-session',
    transcript_path: filePath,
    stop_hook_active: false,
  };

  const { exitCode } = runHook(path.join(CWD, 'hooks/stop.js'), payload);

  try {
    assert.strictEqual(exitCode, 0, `expected exit 0, got ${exitCode}`);

    // Marker should be deleted
    assert(!fs.existsSync(REPARENT_MARKER), 'reparent marker should have been deleted');

    // Entry 4 should now point to anchorUuid
    const after = readSessionEntries(filePath);
    const reparented = after.find(e => e.uuid === uuids[4]);
    assert(reparented, 'entry 4 not found after reparent');
    assert.strictEqual(reparented.parentUuid, anchorUuid,
      `entry 4 parentUuid should be anchor ${anchorUuid.slice(0,8)}, got ${reparented.parentUuid?.slice(0,8)}`);

    pass(name);
  } catch (err) {
    fail(name, err.message);
  } finally {
    try { fs.unlinkSync(filePath); } catch (_) {}
    try { fs.unlinkSync(REPARENT_MARKER); } catch (_) {}
  }
}

function testStopAutoPruneAt42Percent() {
  const name = 'stop.js: at 42% context, exits 2 with prune directive';
  const { filePath, entries } = createTempSession(2);

  // Inject usage at 42% of 1M tokens
  const last = { ...entries[entries.length - 1] };
  last.message = {
    role: 'assistant',
    model: 'claude-sonnet-4-6',
    usage: { input_tokens: 420000, output_tokens: 1000 },
    content: [],
  };
  fs.writeFileSync(filePath, [...entries.slice(0, -1), last].map(e => JSON.stringify(e)).join('\n') + '\n');
  try { fs.unlinkSync(REPARENT_MARKER); } catch (_) {}

  const payload = {
    session_id: 'test-session-42',
    transcript_path: filePath,
    stop_hook_active: false,
  };

  const { exitCode, stderr } = runHook(path.join(CWD, 'hooks/stop.js'), payload);

  try {
    assert.strictEqual(exitCode, 2, `expected exit 2 for auto-prune, got ${exitCode}`);
    assert(stderr.includes('AUTO-PRUNE') || stderr.includes('prune') || stderr.includes('%'),
      `stderr should contain prune directive, got: "${stderr.slice(0, 200)}"`);
    pass(name);
  } catch (err) {
    fail(name, err.message);
  } finally {
    try { fs.unlinkSync(filePath); } catch (_) {}
    // Clean up auto_prune_state.json so it doesn't interfere with other tests
    try { fs.unlinkSync(path.join(CLAUDE_DIR, 'auto_prune_state.json')); } catch (_) {}
  }
}

function testStopEmergencyAt86Percent() {
  const name = 'stop.js: at 86% context, exits 2 with emergency directive';
  const { filePath, entries } = createTempSession(2);

  const last = { ...entries[entries.length - 1] };
  last.message = {
    role: 'assistant',
    model: 'claude-sonnet-4-6',
    usage: { input_tokens: 860000, output_tokens: 1000 },
    content: [],
  };
  fs.writeFileSync(filePath, [...entries.slice(0, -1), last].map(e => JSON.stringify(e)).join('\n') + '\n');
  try { fs.unlinkSync(REPARENT_MARKER); } catch (_) {}

  const payload = {
    session_id: 'test-session-86',
    transcript_path: filePath,
    stop_hook_active: false,
  };

  const { exitCode, stderr } = runHook(path.join(CWD, 'hooks/stop.js'), payload);

  try {
    assert.strictEqual(exitCode, 2, `expected exit 2 for emergency, got ${exitCode}`);
    assert(
      stderr.includes('CRITICAL') || stderr.includes('AUTO-PRUNE') || stderr.includes('%'),
      `stderr should mention critical context, got: "${stderr.slice(0, 200)}"`
    );
    pass(name);
  } catch (err) {
    fail(name, err.message);
  } finally {
    try { fs.unlinkSync(filePath); } catch (_) {}
    try { fs.unlinkSync(path.join(CLAUDE_DIR, 'auto_prune_state.json')); } catch (_) {}
  }
}

// =============================================================================
// post-forget-prune.js tests
// =============================================================================

function testPostForgetPruneWithMarker() {
  const name = 'post-forget-prune.js: with marker, reparents orphans, does NOT delete marker';
  const { filePath, entries, uuids } = createTempSession(5);

  const anchorUuid = uuids[1];
  // Simulate: entries 2 and 3 removed, entry 4 has stale parent
  const kept = [entries[0], entries[1], { ...entries[4], parentUuid: uuids[3] }];
  fs.writeFileSync(filePath, kept.map(e => JSON.stringify(e)).join('\n') + '\n');

  fs.writeFileSync(REPARENT_MARKER, JSON.stringify({ anchorUuid, sessionPath: filePath }));

  const payload = { tool_name: 'mcp__context-manager__forget_prune', tool_input: {} };
  const { exitCode } = runHook(path.join(CWD, 'hooks/post-forget-prune.js'), payload);

  try {
    assert.strictEqual(exitCode, 0, `expected exit 0, got ${exitCode}`);

    // Marker should NOT be deleted (stop hook does final cleanup)
    assert(fs.existsSync(REPARENT_MARKER), 'post-forget-prune should leave marker for stop hook');

    // Orphaned entry should have been reparented
    const after = readSessionEntries(filePath);
    const reparented = after.find(e => e.uuid === uuids[4]);
    assert(reparented, 'entry 4 not found');
    assert.strictEqual(reparented.parentUuid, anchorUuid,
      `entry 4 should be reparented to anchor, got ${reparented.parentUuid?.slice(0,8)}`);

    pass(name);
  } catch (err) {
    fail(name, err.message);
  } finally {
    try { fs.unlinkSync(filePath); } catch (_) {}
    try { fs.unlinkSync(REPARENT_MARKER); } catch (_) {}
  }
}

function testPostForgetPruneNoMarker() {
  const name = 'post-forget-prune.js: no marker, no-ops cleanly';
  const { filePath, entries } = createTempSession(3);
  try { fs.unlinkSync(REPARENT_MARKER); } catch (_) {}

  const originalContent = fs.readFileSync(filePath, 'utf8');
  const payload = { tool_name: 'mcp__context-manager__forget_prune', tool_input: {} };
  const { exitCode } = runHook(path.join(CWD, 'hooks/post-forget-prune.js'), payload);

  try {
    assert.strictEqual(exitCode, 0, `expected exit 0, got ${exitCode}`);
    const afterContent = fs.readFileSync(filePath, 'utf8');
    assert.strictEqual(afterContent, originalContent, 'session should not be mutated when no marker');
    pass(name);
  } catch (err) {
    fail(name, err.message);
  } finally {
    try { fs.unlinkSync(filePath); } catch (_) {}
  }
}

// =============================================================================
// pre-backup.js tests
// =============================================================================

function testPreBackupCreatesBackup() {
  const name = 'pre-backup.js: creates backup file in .claude/backups/';
  const { filePath } = createTempSession(3);

  // Write session path file so pre-backup can discover the session
  fs.writeFileSync(path.join(CLAUDE_DIR, 'session_path.txt'), filePath);

  const payload = {
    tool_name: 'mcp__context-manager__summarize_topic',
    tool_input: { session_path: filePath, topic_id: 'test-topic' },
  };

  const backupsBefore = fs.readdirSync(BACKUP_DIR).length;
  const { exitCode } = runHook(path.join(CWD, 'hooks/pre-backup.js'), payload);

  try {
    assert.strictEqual(exitCode, 0, `expected exit 0, got ${exitCode}`);
    const backupsAfter = fs.readdirSync(BACKUP_DIR).length;
    assert(backupsAfter > backupsBefore, 'no backup file created');

    // Find the newly created backup
    const basename = path.basename(filePath, '.jsonl');
    const backupFiles = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith(basename + '_') && f.endsWith('.jsonl'));
    assert(backupFiles.length > 0, 'backup file not found');

    pass(name);
  } catch (err) {
    fail(name, err.message);
  } finally {
    try { fs.unlinkSync(filePath); } catch (_) {}
    // Clean up backup
    const basename = path.basename(filePath, '.jsonl');
    for (const f of fs.readdirSync(BACKUP_DIR)) {
      if (f.startsWith(basename + '_')) try { fs.unlinkSync(path.join(BACKUP_DIR, f)); } catch (_) {}
    }
  }
}

// =============================================================================
// gardener.js tests
// =============================================================================

const GARDENER_STATE = path.join(CLAUDE_DIR, 'gardener-state.json');

/**
 * Build a multi-topic session JSONL for gardener tests.
 * topics: array of { name, withToolResult, withDormantSummary, tokenUsage }
 * Last topic is always "current".
 */
function createGardenerSession(topics, usageTokens = 1000) {
  const filePath = path.join(CLAUDE_DIR, `test-gardener-${Date.now()}.jsonl`);
  const entries = [];
  const sessionId = 'gardener-test-session';
  let prevUuid = null;

  for (let t = 0; t < topics.length; t++) {
    const topic = topics[t];
    const isFirst = t === 0;

    // Topic boundary: assistant message starting with "Now " (except first topic)
    const boundaryUuid = uuidv4();
    const boundaryText = isFirst ? `Working on: ${topic.name}` : `Now working on: ${topic.name}`;
    entries.push({
      uuid: boundaryUuid,
      parentUuid: prevUuid,
      type: 'assistant',
      sessionId,
      timestamp: new Date().toISOString(),
      message: {
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        content: [{ type: 'text', text: boundaryText }],
        ...(t === topics.length - 1 ? { usage: { input_tokens: usageTokens, output_tokens: 100 } } : {}),
      },
    });
    prevUuid = boundaryUuid;

    // Add filler messages so every topic has >= TOPIC_MIN_MESSAGES (4) messages
    // and survives the merge heuristic in getTopics().
    for (let f = 0; f < 3; f++) {
      const fillerUuid = uuidv4();
      entries.push({
        uuid: fillerUuid,
        parentUuid: prevUuid,
        type: 'assistant',
        sessionId,
        timestamp: new Date().toISOString(),
        message: { role: 'assistant', model: 'claude-sonnet-4-6', content: [{ type: 'text', text: `Step ${f + 1}.` }] },
      });
      prevUuid = fillerUuid;
    }

    // Optional tool_result entry
    if (topic.withToolResult) {
      const toolUseUuid = uuidv4();
      entries.push({
        uuid: toolUseUuid,
        parentUuid: prevUuid,
        type: 'assistant',
        sessionId,
        timestamp: new Date().toISOString(),
        message: {
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          content: [{ type: 'tool_use', id: `toolu_${toolUseUuid.slice(0,8)}`, name: 'Read', input: { file_path: '/tmp/test.txt' } }],
        },
      });
      prevUuid = toolUseUuid;

      const resultUuid = uuidv4();
      const blob = topic.withToolResult === 'large'
        ? 'x'.repeat(12000) // ~12KB — exceeds TIER1_MIN_TOTAL_BYTES (10KB) on its own
        : 'small result';
      entries.push({
        uuid: resultUuid,
        parentUuid: prevUuid,
        type: 'user',
        sessionId,
        timestamp: new Date().toISOString(),
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: `toolu_${toolUseUuid.slice(0,8)}`, content: [{ type: 'text', text: blob }] }],
        },
      });
      prevUuid = resultUuid;

      // Optional dormant summary for this topic
      if (topic.withDormantSummary) {
        const topicId = boundaryUuid; // first uuid of this topic
        const dormantAssistantUuid = uuidv4();
        entries.push({
          uuid: dormantAssistantUuid,
          parentUuid: null,
          dormantSummaryFor: topicId,
          type: 'assistant',
          sessionId,
          timestamp: new Date().toISOString(),
          message: {
            role: 'assistant',
            model: 'claude-sonnet-4-6',
            stop_reason: 'tool_use',
            content: [{ type: 'tool_use', id: `toolu_dormant_${dormantAssistantUuid.slice(0,8)}`, name: 'Agent', input: { subagent_type: 'summarizer', prompt: 'summarize' } }],
          },
        });
        const dormantResultUuid = uuidv4();
        entries.push({
          uuid: dormantResultUuid,
          parentUuid: dormantAssistantUuid,
          dormantSummaryFor: topicId,
          type: 'user',
          sessionId,
          timestamp: new Date().toISOString(),
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: `toolu_dormant_${dormantAssistantUuid.slice(0,8)}`, content: [{ type: 'text', text: 'Summary of topic.' }] }],
          },
        });
      }
    }
  }

  fs.writeFileSync(filePath, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  return { filePath, sessionId, entries };
}

function testGardenerFewTopics() {
  const name = 'gardener.js: exits 0 silently with fewer than 3 topics';
  try { fs.unlinkSync(GARDENER_STATE); } catch (_) {}
  const { filePath, sessionId } = createGardenerSession([
    { name: 'Topic A', withToolResult: true },
    { name: 'Topic B (current)' },
  ]);
  const payload = { session_id: sessionId, transcript_path: filePath, stop_hook_active: false };
  const { exitCode, stderr } = runHook(path.join(CWD, 'hooks/gardener.js'), payload);
  try {
    assert.strictEqual(exitCode, 0, `expected exit 0, got ${exitCode}`);
    assert.strictEqual(stderr.trim(), '', `expected no output, got: ${stderr.trim()}`);
    pass(name);
  } catch (err) { fail(name, err.message); }
  finally { try { fs.unlinkSync(filePath); } catch (_) {} }
}

function testGardenerUnsummarizedTopic() {
  const name = 'gardener.js: exits 2 naming unsummarized topic with tool results';
  try { fs.unlinkSync(GARDENER_STATE); } catch (_) {}
  const { filePath, sessionId } = createGardenerSession([
    { name: 'Initial setup', withToolResult: 'large' },
    { name: 'Fix bug', withToolResult: true },
    { name: 'Refactor step' },
    { name: 'Current work (current)' },
  ]);
  const payload = { session_id: sessionId, transcript_path: filePath, stop_hook_active: false };
  const { exitCode, stderr } = runHook(path.join(CWD, 'hooks/gardener.js'), payload);
  try {
    assert.strictEqual(exitCode, 2, `expected exit 2, got ${exitCode}`);
    assert.ok(stderr.includes('Initial setup') || stderr.includes('Fix bug'),
      `expected topic name in output, got: ${stderr.trim()}`);
    assert.ok(stderr.toLowerCase().includes('prune'), `expected /prune mention, got: ${stderr.trim()}`);
    pass(name);
  } catch (err) { fail(name, err.message); }
  finally { try { fs.unlinkSync(filePath); } catch (_) {} }
}

function testGardenerAlreadySuggested() {
  const name = 'gardener.js: exits 0 when topic already suggested this session';
  const { filePath, sessionId } = createGardenerSession([
    { name: 'Old work', withToolResult: 'large' },
    { name: 'Middle topic', withToolResult: true },
    { name: 'Current (current)' },
  ]);

  // Pre-populate state with the topic IDs
  const entries = fs.readFileSync(filePath, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
  // The first boundary entry of 'Old work' is the first entry with that text
  const oldWorkEntry = entries.find(e => e.message?.content?.[0]?.text?.includes('Old work'));
  const middleEntry = entries.find(e => e.message?.content?.[0]?.text?.includes('Middle topic'));
  const suggestedTopics = [oldWorkEntry?.uuid, middleEntry?.uuid].filter(Boolean);
  fs.writeFileSync(GARDENER_STATE, JSON.stringify({ sessionId, suggestedTopics }));

  const payload = { session_id: sessionId, transcript_path: filePath, stop_hook_active: false };
  const { exitCode, stderr } = runHook(path.join(CWD, 'hooks/gardener.js'), payload);
  try {
    assert.strictEqual(exitCode, 0, `expected exit 0 (already suggested), got ${exitCode}: ${stderr}`);
    pass(name);
  } catch (err) { fail(name, err.message); }
  finally {
    try { fs.unlinkSync(filePath); } catch (_) {}
    try { fs.unlinkSync(GARDENER_STATE); } catch (_) {}
  }
}

function testGardenerAllSummarized() {
  const name = 'gardener.js: exits 0 when all non-current topics have dormant summaries';
  try { fs.unlinkSync(GARDENER_STATE); } catch (_) {}
  const { filePath, sessionId } = createGardenerSession([
    { name: 'Done topic A', withToolResult: 'large', withDormantSummary: true },
    { name: 'Done topic B', withToolResult: true, withDormantSummary: true },
    { name: 'Current (current)' },
  ]);
  const payload = { session_id: sessionId, transcript_path: filePath, stop_hook_active: false };
  const { exitCode, stderr } = runHook(path.join(CWD, 'hooks/gardener.js'), payload);
  try {
    assert.strictEqual(exitCode, 0, `expected exit 0 (all summarized), got ${exitCode}: ${stderr}`);
    pass(name);
  } catch (err) { fail(name, err.message); }
  finally { try { fs.unlinkSync(filePath); } catch (_) {} }
}

function testGardenerCriticalUrgency() {
  const name = 'gardener.js: critical urgency message at >85% context';
  try { fs.unlinkSync(GARDENER_STATE); } catch (_) {}
  // 870000 / 1000000 = 87%
  const { filePath, sessionId } = createGardenerSession([
    { name: 'Big file read', withToolResult: 'large' },
    { name: 'Another topic', withToolResult: true },
    { name: 'Middle step' },
    { name: 'Current (current)' },
  ], 870000);
  const payload = { session_id: sessionId, transcript_path: filePath, stop_hook_active: false };
  const { exitCode, stderr } = runHook(path.join(CWD, 'hooks/gardener.js'), payload);
  try {
    assert.strictEqual(exitCode, 2, `expected exit 2, got ${exitCode}`);
    assert.ok(stderr.includes('CRITICAL') || stderr.includes('URGENT'),
      `expected urgency prefix, got: ${stderr.trim()}`);
    pass(name);
  } catch (err) { fail(name, err.message); }
  finally { try { fs.unlinkSync(filePath); } catch (_) {} }
}



async function main() {
  console.log('Hook Tests — direct stdin-piping, no LLM\n');

  // stop.js tests
  console.log('stop.js:');
  testStopNoMarker();
  testStopWithMarkerReparents();
  testStopAutoPruneAt42Percent();
  testStopEmergencyAt86Percent();

  // post-forget-prune.js tests
  console.log('\npost-forget-prune.js:');
  testPostForgetPruneWithMarker();
  testPostForgetPruneNoMarker();

  // pre-backup.js tests
  console.log('\npre-backup.js:');
  testPreBackupCreatesBackup();

  // gardener.js tests
  console.log('\ngardener.js:');
  testGardenerFewTopics();
  testGardenerUnsummarizedTopic();
  testGardenerAlreadySuggested();
  testGardenerAllSummarized();
  testGardenerCriticalUrgency();

  console.log(`\n${passed + failed} hook tests: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
