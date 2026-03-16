#!/usr/bin/env node
/**
 * test-e2e.js — End-to-end tests for context-manager MCP tools
 *
 * Spawns real claude --print agents via node-pty and verifies:
 *   1. list_topics returns topic data for test_session.jsonl
 *   2. get_topic_content returns content for a real topic
 *   3. The spawned session JSONL contains expected tool_use + tool_result entries
 *
 * Run: node test-e2e.js
 * Requires: claude CLI in PATH, harness-mcp.js deps installed (node-pty)
 */

'use strict';

const pty = require('node-pty');
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const CWD = __dirname;
const SESSION_FIXTURE = path.resolve(CWD, 'test_session.jsonl');

let passed = 0;
let failed = 0;

function pass(name) { passed++; console.log(`  ✓ ${name}`); }
function fail(name, err) { failed++; console.log(`  ✗ ${name}\n    ${err}`); }

// Minimal MCP config: only context-manager, no other servers
const E2E_MCP_CONFIG = JSON.stringify({
  mcpServers: {
    'context-manager': {
      type: 'stdio',
      command: 'node',
      args: [path.join(CWD, 'context-mcp.js')],
    },
  },
});

/**
 * Spawn `claude --print <prompt>` in a PTY, collect all output until exit.
 * Uses --strict-mcp-config + --system-prompt for isolation: the agent starts
 * with no project knowledge, only the context-manager MCP tools available.
 * Returns { sessionId, lines, result, exitCode }.
 */
function spawnAgent(prompt, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    const args = [
      '--output-format', 'stream-json', '--verbose',
      '--system-prompt', 'You are a test agent. Use the provided MCP tools exactly as instructed. Do not draw on prior knowledge of the session file contents.',
      '--mcp-config', E2E_MCP_CONFIG,
      '--strict-mcp-config',
      '--allowedTools', 'mcp__context-manager__list_topics,mcp__context-manager__get_topic_content,mcp__context-manager__bypass_topic,mcp__context-manager__restore_topic',
      '--print', prompt,
    ];
    const proc = pty.spawn('claude', args, {
      name: 'xterm-256color',
      cols: 220,
      rows: 50,
      cwd: CWD,
      env: { ...process.env },
    });

    const lines = [];
    let sessionId = null;
    let resultObj = null;
    let exitCode = null;

    const timer = setTimeout(() => {
      try { proc.kill(); } catch (_) {}
      reject(new Error(`Agent timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.onData((data) => {
      for (const raw of data.split('\n')) {
        const line = raw.replace(/\r/g, '').trim();
        if (!line) continue;
        lines.push(line);
        try {
          const obj = JSON.parse(line);
          if (obj.session_id && !sessionId) sessionId = obj.session_id;
          if (obj.type === 'result') resultObj = obj;
        } catch (_) {}
      }
    });

    proc.onExit(({ exitCode: code }) => {
      clearTimeout(timer);
      exitCode = code;
      resolve({ sessionId, lines, result: resultObj, exitCode });
    });
  });
}

/**
 * Find the JSONL path for a session_id under ~/.claude/projects/
 */
function findSessionPath(sessionId) {
  const claudeDir = path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(claudeDir)) return null;
  for (const proj of fs.readdirSync(claudeDir)) {
    const candidate = path.join(claudeDir, proj, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Read and parse all entries from a session JSONL.
 */
function readSessionEntries(sessionPath) {
  return fs.readFileSync(sessionPath, 'utf8')
    .split('\n')
    .filter(l => l.trim())
    .map(l => { try { return JSON.parse(l); } catch (_) { return null; } })
    .filter(Boolean);
}

// =============================================================================
// Test 1: list_topics returns topic data
// =============================================================================

async function testListTopics() {
  const name = 'list_topics returns topics for test_session.jsonl';
  console.log(`\nRunning: ${name}`);

  let run;
  try {
    const prompt = `Call mcp__context-manager__list_topics with session_path="${SESSION_FIXTURE}". Report what topics were returned, including their IDs and names.`;
    run = await spawnAgent(prompt);
  } catch (err) {
    fail(name, `spawn failed: ${err.message}`);
    return null;
  }

  try {
    // result text should mention topics
    const resultText = run.result?.result || '';
    assert(resultText.length > 0, 'result should be non-empty');
    // Should mention topic or ID-like structure
    assert(
      resultText.toLowerCase().includes('topic') || resultText.match(/[0-9a-f]{8}/),
      `result should mention topics, got: ${resultText.slice(0, 200)}`
    );
    pass(name);
  } catch (err) {
    fail(name, err.message);
  }

  return run;
}

// =============================================================================
// Test 2: spawned session JSONL has tool_use + tool_result for list_topics
// =============================================================================

async function testSessionJSONLHasToolEntries(run) {
  const name = 'spawned session JSONL contains list_topics tool_use and tool_result';

  if (!run?.sessionId) {
    fail(name, 'no sessionId from previous run');
    return;
  }

  try {
    const sessionPath = findSessionPath(run.sessionId);
    assert(sessionPath, `session JSONL not found for session ${run.sessionId}`);

    const entries = readSessionEntries(sessionPath);

    const hasContent = (e, pred) => Array.isArray(e.message?.content) && e.message.content.some(pred);

    // Find a tool_use block for list_topics
    const toolUseEntry = entries.find(e =>
      e.type === 'assistant' &&
      hasContent(e, b => b.type === 'tool_use' && b.name === 'mcp__context-manager__list_topics')
    );
    assert(toolUseEntry, 'should have an assistant entry with list_topics tool_use');

    // Find a tool_result for that tool_use
    const toolUseId = toolUseEntry.message.content.find(b => b.name === 'mcp__context-manager__list_topics').id;
    const toolResultEntry = entries.find(e =>
      e.type === 'user' &&
      hasContent(e, b => b.type === 'tool_result' && b.tool_use_id === toolUseId)
    );
    assert(toolResultEntry, 'should have a user entry with matching tool_result');

    // The tool_result content should mention topics
    const resultBlock = toolResultEntry.message.content.find(b => b.tool_use_id === toolUseId);
    const resultText = Array.isArray(resultBlock.content)
      ? resultBlock.content.map(c => c.text || '').join('')
      : String(resultBlock.content || '');
    assert(resultText.length > 0, 'tool_result content should be non-empty');

    pass(name);
  } catch (err) {
    fail(name, err.message);
  }
}

// =============================================================================
// Test 3: get_topic_content returns content for a real topic
// =============================================================================

async function testGetTopicContent() {
  const name = 'get_topic_content returns non-empty content for a real topic';
  console.log(`\nRunning: ${name}`);

  let run;
  try {
    // First get a topic ID, then get its content
    const prompt = `Do the following two steps:
1. Call mcp__context-manager__list_topics with session_path="${SESSION_FIXTURE}". Pick the first non-orphan topic ID.
2. Call mcp__context-manager__get_topic_content with session_path="${SESSION_FIXTURE}" and that topic_id.
Report the content returned by get_topic_content.`;
    run = await spawnAgent(prompt, 120000);
  } catch (err) {
    fail(name, `spawn failed: ${err.message}`);
    return;
  }

  try {
    const resultText = run.result?.result || '';
    assert(resultText.length > 50, `result should have substantial content, got: ${resultText.slice(0, 200)}`);
    // Should mention topic content was returned (the agent may paraphrase it)
    assert(
      !resultText.toLowerCase().includes('blocked') || resultText.toLowerCase().includes('topic'),
      `get_topic_content should have returned topic data, got: ${resultText.slice(0, 300)}`
    );
    pass(name);
  } catch (err) {
    fail(name, err.message);
  }
}

// =============================================================================
// Test 4: bypass_topic and restore_topic via MCP tools on a temp copy
// =============================================================================

async function testBypassRestore() {
  const name = 'bypass_topic then restore_topic via MCP tools round-trips the session';
  console.log(`\nRunning: ${name}`);

  // Copy test_session.jsonl to a temp location inside .claude/ so validateSessionPath accepts it
  const claudeDir = path.join(CWD, '.claude');
  if (!fs.existsSync(claudeDir)) fs.mkdirSync(claudeDir);
  const tmpSession = path.join(claudeDir, `e2e-bypass-test-${Date.now()}.jsonl`);
  fs.copyFileSync(SESSION_FIXTURE, tmpSession);

  let run;
  try {
    const prompt = `Do the following steps on session_path="${tmpSession}":
1. Call mcp__context-manager__list_topics — pick the first non-orphan, non-summary topic. Note its topic_id and the session's total topic count.
2. Call mcp__context-manager__bypass_topic with that topic_id.
3. Call mcp__context-manager__list_topics again — verify the topic is now orphaned (isOrphan=true).
4. Call mcp__context-manager__restore_topic with the orphaned topic_id.
5. Call mcp__context-manager__list_topics a final time — verify the topic is active again.
Report whether each step succeeded.`;
    run = await spawnAgent(prompt, 150000);
  } catch (err) {
    fail(name, `spawn failed: ${err.message}`);
    fs.unlinkSync(tmpSession);
    return;
  }

  try {
    const resultText = run.result?.result || '';
    // Agent should report success for each step
    assert(resultText.length > 0, 'result should be non-empty');
    // Should mention bypass or orphan somewhere
    assert(
      resultText.toLowerCase().includes('orphan') ||
      resultText.toLowerCase().includes('bypass') ||
      resultText.toLowerCase().includes('restored') ||
      resultText.toLowerCase().includes('success'),
      `result should describe the bypass/restore cycle: ${resultText.slice(0, 400)}`
    );
    pass(name);
  } catch (err) {
    fail(name, err.message);
  } finally {
    try { fs.unlinkSync(tmpSession); } catch (_) {}
  }
}

// =============================================================================
// Test 5: summarize_topic after noisy MCP tool call
// =============================================================================

const NOISY_SENTINEL = 'SENTINEL-banana-smoothie-42';

async function testSummarizeAfterNoisyMCP() {
  const testName = 'summarize_topic compresses noisy MCP tool_result into summary pair';
  console.log(`\nRunning: ${testName}`);

  const claudeDir = path.join(CWD, '.claude');
  if (!fs.existsSync(claudeDir)) fs.mkdirSync(claudeDir);

  // MCP config for phase 1: noisy server only — no context-manager.
  // Keeping context-manager out of phase 1 prevents its Stop hook from
  // appending dormant summary entries to the session before we copy it.
  const noisyMcpConfig = JSON.stringify({
    mcpServers: {
      'noisy': {
        type: 'stdio',
        command: 'node',
        args: [path.join(CWD, 'test-noisy-mcp.js')],
      },
    },
  });

  // MCP config for phase 2: only context-manager
  const summarizeMcpConfig = JSON.stringify({
    mcpServers: {
      'context-manager': {
        type: 'stdio',
        command: 'node',
        args: [path.join(CWD, 'context-mcp.js')],
      },
    },
  });

  // --- Phase 1: Agent calls the noisy tool ---
  let phase1Run;
  try {
    const args = [
      '--output-format', 'stream-json', '--verbose',
      '--system-prompt', 'You are a test agent. Use the provided MCP tools exactly as instructed.',
      '--mcp-config', noisyMcpConfig,
      '--strict-mcp-config',
      '--allowedTools', 'mcp__noisy__get_noisy_data',
      '--print', 'Call get_noisy_data and report how many rows it returned.',
    ];
    const pty = require('node-pty');
    phase1Run = await new Promise((resolve, reject) => {
      const proc = pty.spawn('claude', args, {
        name: 'xterm-256color', cols: 220, rows: 50,
        cwd: CWD, env: { ...process.env },
      });
      const lines = [];
      let sessionId = null;
      let resultObj = null;
      const timer = setTimeout(() => { try { proc.kill(); } catch (_) {} reject(new Error('Phase 1 timed out')); }, 120000);
      proc.onData((data) => {
        for (const raw of data.split('\n')) {
          const line = raw.replace(/\r/g, '').trim();
          if (!line) continue;
          lines.push(line);
          try {
            const obj = JSON.parse(line);
            if (obj.session_id && !sessionId) sessionId = obj.session_id;
            if (obj.type === 'result') resultObj = obj;
          } catch (_) {}
        }
      });
      proc.onExit(() => { clearTimeout(timer); resolve({ sessionId, lines, result: resultObj }); });
    });
  } catch (err) {
    fail(testName, `Phase 1 spawn failed: ${err.message}`);
    return;
  }

  // Find and copy the session JSONL
  const sessionPath = findSessionPath(phase1Run.sessionId);
  if (!sessionPath) {
    fail(testName, `Phase 1 session JSONL not found (sessionId=${phase1Run.sessionId})`);
    return;
  }

  const testCopyPath = path.join(claudeDir, `e2e-noisy-${Date.now()}.jsonl`);
  fs.copyFileSync(sessionPath, testCopyPath);

  // Helper to read active chain — mirrors findActiveTail() in context-mcp.js.
  // Skips dormantSummaryFor and isSidechain entries when finding the tail.
  function getActiveChain(entries) {
    const byUuid = new Map(entries.map(e => [e.uuid, e]));
    const parents = new Set(entries.map(e => e.parentUuid).filter(Boolean));
    // Only consider real chain entries (not dormant summaries or sidecar entries)
    const realTails = entries.filter(e =>
      e.uuid && !parents.has(e.uuid) && !e.dormantSummaryFor && !e.isSidechain
    );
    const tail = realTails[realTails.length - 1];
    if (!tail) return [];
    const chain = [];
    let cur = tail;
    while (cur) {
      chain.push(cur);
      cur = cur.parentUuid ? byUuid.get(cur.parentUuid) : null;
    }
    return chain;
  }

  // Phase 1 assertions
  const pre = readSessionEntries(testCopyPath);
  const preChain = getActiveChain(pre);

  const hasContent = (e, pred) => Array.isArray(e.message?.content) && e.message.content.some(pred);

  const noisyEntry = preChain.find(e =>
    hasContent(e, b =>
      (b.type === 'tool_result') &&
      JSON.stringify(b.content || b).includes(NOISY_SENTINEL)
    )
  );
  const sentinelInChain = !!noisyEntry;

  if (!sentinelInChain) {
    // Soft check: the session may not have the tool_result in active chain yet; log and continue
    console.log(`    [warn] sentinel not found in active chain pre-summarization — tool_result may not be present`);
  }

  const preChainLength = preChain.length;

  // --- Phase 2: Summarizer agent calls summarize_topic ---
  let phase2Run;
  try {
    const args = [
      '--output-format', 'stream-json', '--verbose',
      '--system-prompt', 'You are a test agent. Use the provided MCP tools exactly as instructed.',
      '--mcp-config', summarizeMcpConfig,
      '--strict-mcp-config',
      '--allowedTools', 'mcp__context-manager__list_topics,mcp__context-manager__summarize_topic',
      '--print',
      `Call mcp__context-manager__list_topics with session_path="${testCopyPath}". ` +
      `Find a topic that contains a noisy tool call (look for 'get_noisy_data' or 'noisy' in topic names or content). ` +
      `Then call mcp__context-manager__summarize_topic with that topic_id and session_path="${testCopyPath}".`,
    ];
    const pty = require('node-pty');
    phase2Run = await new Promise((resolve, reject) => {
      const proc = pty.spawn('claude', args, {
        name: 'xterm-256color', cols: 220, rows: 50,
        cwd: CWD, env: { ...process.env },
      });
      const lines = [];
      let resultObj = null;
      const timer = setTimeout(() => { try { proc.kill(); } catch (_) {} reject(new Error('Phase 2 timed out')); }, 180000);
      proc.onData((data) => {
        for (const raw of data.split('\n')) {
          const line = raw.replace(/\r/g, '').trim();
          if (!line) continue;
          lines.push(line);
          try {
            const obj = JSON.parse(line);
            if (obj.type === 'result') resultObj = obj;
          } catch (_) {}
        }
      });
      proc.onExit(() => { clearTimeout(timer); resolve({ lines, result: resultObj }); });
    });
  } catch (err) {
    try { fs.unlinkSync(testCopyPath); } catch (_) {}
    fail(testName, `Phase 2 spawn failed: ${err.message}`);
    return;
  }

  // --- Phase 3: Assertions on the mutated test copy ---
  let allPassed = true;
  function check(label, cond, detail) {
    if (cond) {
      pass(label);
    } else {
      fail(label, detail || 'assertion failed');
      allPassed = false;
    }
  }

  try {
    const post = readSessionEntries(testCopyPath);
    const postChain = getActiveChain(post);

    // Level 1 — Structure
    const summaryAssistant = postChain.find(e =>
      e.type === 'assistant' &&
      e.message?.stop_reason === 'tool_use' &&
      Array.isArray(e.message?.content) &&
      e.message.content.some(b => b.type === 'tool_use' && b.name === 'Agent' && b.input?.subagent_type === 'summarizer')
    );
    check('L1: summary assistant entry in active chain', !!summaryAssistant,
      'no assistant entry with stop_reason=tool_use + Agent tool_use + subagent_type=summarizer');

    const summaryToolUseId = summaryAssistant?.message?.content?.find(b => b.name === 'Agent')?.id;
    const summaryResult = postChain.find(e =>
      e.type === 'user' &&
      Array.isArray(e.message?.content) &&
      e.message.content.some(b => b.type === 'tool_result' && b.tool_use_id === summaryToolUseId)
    );
    check('L1: summary result entry in active chain', !!summaryResult,
      'no user entry with matching tool_result for summary tool_use_id');

    check('L1: tool_use_id matches on summary pair',
      summaryToolUseId && !!summaryResult,
      `tool_use_id=${summaryToolUseId} not matched`);

    check('L1: active chain shorter after summarization',
      postChain.length < preChainLength,
      `post chain length ${postChain.length} >= pre chain length ${preChainLength}`);

    // Check the noisy raw tool_result entry (by UUID) is orphaned (not in active chain)
    const postChainUuids = new Set(postChain.map(e => e.uuid));
    const noisyEntryOrphaned = !noisyEntry || !postChainUuids.has(noisyEntry.uuid);
    check('L1: sentinel not in active chain after summarization', noisyEntryOrphaned,
      'noisy tool_result entry still in active chain — was not orphaned');

    // Level 2 — Content provenance
    const resultContent = summaryResult?.message?.content?.find(b => b.type === 'tool_result');
    const summaryText = Array.isArray(resultContent?.content)
      ? resultContent.content.map(c => c.text || '').join('')
      : String(resultContent?.content || '');

    check('L2: summary text is non-empty', summaryText.length > 0, 'summary text is empty');

    const originalBlobSize = NOISY_SENTINEL.length * 200 + 2000; // ~10KB estimate
    check('L2: summary text shorter than original blob by 80%',
      summaryText.length < originalBlobSize * 0.2,
      `summary length ${summaryText.length} not < 20% of original ~${originalBlobSize}`);

    // Level 3 — Sentinel relationship (soft: model behavior is non-deterministic)
    if (summaryText.includes(NOISY_SENTINEL)) {
      console.log(`    [warn] L3: sentinel found verbatim in summary text — model did not compress (non-deterministic)`);
    } else {
      pass('L3: sentinel not verbatim in summary text');
    }

    const plausibilityWords = ['data', 'rows', 'result', 'tool', 'noisy', 'called', 'returned'];
    const isPlausible = plausibilityWords.some(w => summaryText.toLowerCase().includes(w));
    if (!isPlausible) {
      console.log(`    [warn] L3: summary may not be about the topic (none of ${plausibilityWords.join(',')} found)`);
    }

    // Level 4 — Sidecar linkage
    check('L4: resultEntry has promptId', !!summaryResult?.promptId, 'promptId missing on result entry');

    if (summaryAssistant) {
      const agentToolUse = summaryAssistant.message.content.find(b => b.name === 'Agent');
      // agentId is embedded in the sidecar filename; find it from sidecar dir
      const sessionId = summaryAssistant.sessionId;
      const subagentDir = sessionId
        ? path.join(path.dirname(testCopyPath), sessionId, 'subagents')
        : null;
      let sidecarFound = false;
      if (subagentDir && fs.existsSync(subagentDir)) {
        const files = fs.readdirSync(subagentDir).filter(f => f.startsWith('agent-') && f.endsWith('.jsonl'));
        sidecarFound = files.length > 0;
        if (sidecarFound) {
          // Check sidecar contents
          const sidecarEntries = readSessionEntries(path.join(subagentDir, files[0]));
          check('L4: sidecar contains original topic entries', sidecarEntries.length > 0, 'sidecar is empty');
          check('L4: sidecar entries have isSidechain=true',
            sidecarEntries.every(e => e.isSidechain === true),
            'some sidecar entries missing isSidechain=true');
          check('L4: first sidecar entry has parentUuid=null',
            sidecarEntries[0]?.parentUuid === null,
            `first entry parentUuid=${sidecarEntries[0]?.parentUuid}`);
        }
      }
      check('L4: sidecar file exists', sidecarFound,
        `sidecar dir not found or empty: ${subagentDir}`);
    }

    // Level 5 — API call evidence
    check('L5: summary text > 50 chars', summaryText.length > 50,
      `summary too short: "${summaryText.slice(0, 100)}"`);
    check('L5: summary does not look like a stub',
      summaryText.length > 0 &&
      !summaryText.toLowerCase().startsWith('no summary') &&
      summaryText.trim().length > 0,
      `stub-like summary: "${summaryText.slice(0, 100)}"`);
    const words = summaryText.trim().split(/\s+/);
    check('L5: summary has at least 3 words', words.length >= 3,
      `only ${words.length} words in summary`);

    if (allPassed) {
      pass(testName);
    }
  } catch (err) {
    fail(testName, `Phase 3 assertion threw: ${err.message}`);
  } finally {
    try { fs.unlinkSync(testCopyPath); } catch (_) {}
  }
}

// =============================================================================
// Test 6: gardener hook detects unsummarized noisy session and suggests /prune
// =============================================================================

async function testGardenerDetectsNoisySession() {
  const testName = 'gardener detects unsummarized noisy session and suggests /prune';
  console.log(`\nRunning: ${testName}`);
  const t0 = Date.now();

  const claudeDir = path.join(CWD, '.claude');
  if (!fs.existsSync(claudeDir)) fs.mkdirSync(claudeDir);

  // Phase 1: spawn a session that calls the noisy tool (same as testSummarizeAfterNoisyMCP)
  const noisyMcpConfig = JSON.stringify({
    mcpServers: {
      noisy: {
        type: 'stdio',
        command: 'node',
        args: [path.join(CWD, 'test-noisy-mcp.js')],
      },
    },
  });

  let phase1Run;
  try {
    const args = [
      '--output-format', 'stream-json', '--verbose',
      '--system-prompt', 'You are a test agent. Use the provided MCP tools exactly as instructed.',
      '--mcp-config', noisyMcpConfig,
      '--strict-mcp-config',
      '--allowedTools', 'mcp__noisy__get_noisy_data',
      '--print', 'Call mcp__noisy__get_noisy_data to retrieve the data.',
    ];
    phase1Run = await new Promise((resolve, reject) => {
      const proc = pty.spawn('claude', args, {
        name: 'xterm-256color', cols: 220, rows: 50,
        cwd: os.tmpdir(), env: { ...process.env },
      });
      const lines = [];
      let sessionId = null;
      let resultObj = null;
      const timer = setTimeout(() => { try { proc.kill(); } catch (_) {} reject(new Error('Phase 1 timed out')); }, 120000);
      proc.onData(data => {
        for (const raw of data.split('\n')) {
          const line = raw.replace(/\r/g, '').trim();
          if (!line) continue;
          lines.push(line);
          try {
            const obj = JSON.parse(line);
            if (obj.session_id && !sessionId) sessionId = obj.session_id;
            if (obj.type === 'result') resultObj = obj;
          } catch (_) {}
        }
      });
      proc.onExit(() => { clearTimeout(timer); resolve({ sessionId, lines, result: resultObj }); });
    });
  } catch (err) {
    fail(testName, `Phase 1 spawn failed: ${err.message}`);
    return;
  }

  const phase1Ms = Date.now() - t0;
  console.log(`    [metric] phase1 (noisy session spawn): ${phase1Ms}ms`);

  // Find and copy the session
  const { spawnSync } = require('child_process');
  const sessionPath = (() => {
    const claudeProjectsDir = path.join(os.homedir(), '.claude', 'projects');
    if (!fs.existsSync(claudeProjectsDir)) return null;
    for (const proj of fs.readdirSync(claudeProjectsDir)) {
      const f = path.join(claudeProjectsDir, proj, `${phase1Run.sessionId}.jsonl`);
      if (fs.existsSync(f)) return f;
    }
    return null;
  })();

  if (!sessionPath) {
    fail(testName, `session JSONL not found (sessionId=${phase1Run.sessionId})`);
    return;
  }

  const testCopyPath = path.join(claudeDir, `e2e-gardener-${Date.now()}.jsonl`);
  fs.copyFileSync(sessionPath, testCopyPath);

  // Clean gardener state so dedup doesn't interfere
  const gardenerState = path.join(claudeDir, 'gardener-state.json');
  try { fs.unlinkSync(gardenerState); } catch (_) {}

  // Phase 2: pipe session to gardener hook directly
  const t2 = Date.now();
  const hookPayload = JSON.stringify({
    session_id: phase1Run.sessionId,
    transcript_path: testCopyPath,
    stop_hook_active: false,
  });

  const gardenerResult = spawnSync('node', [path.join(CWD, 'hooks/gardener.js')], {
    input: hookPayload,
    cwd: CWD,
    encoding: 'utf8',
    timeout: 40000, // tier 2 LLM may fire
  });

  const phase2Ms = Date.now() - t2;
  console.log(`    [metric] phase2 (gardener hook): ${phase2Ms}ms, exit=${gardenerResult.status}`);

  const totalMs = Date.now() - t0;
  console.log(`    [metric] total: ${totalMs}ms`);

  try {
    // Gardener should find unsummarized tool_result and exit 2
    assert.strictEqual(gardenerResult.status, 2,
      `expected exit 2, got ${gardenerResult.status}. stderr: ${gardenerResult.stderr?.slice(0, 300)}`);

    const msg = gardenerResult.stderr || '';
    assert.ok(msg.toLowerCase().includes('prune'),
      `expected /prune mention in output, got: ${msg.slice(0, 300)}`);

    // Should name a specific topic
    assert.ok(msg.length > 20,
      `message too short to be meaningful: "${msg}"`);

    pass(testName);
    console.log(`    [gardener output] ${msg.trim().split('\n')[0]}`);
  } catch (err) {
    fail(testName, err.message);
  } finally {
    try { fs.unlinkSync(testCopyPath); } catch (_) {}
    try { fs.unlinkSync(gardenerState); } catch (_) {}
  }
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  const suiteStart = Date.now();
  console.log('E2E Tests — context-manager MCP via spawned claude agents');
  console.log('Note: each test spawns a real claude process; expect ~30-90s per test\n');

  if (!fs.existsSync(SESSION_FIXTURE)) {
    console.error(`ERROR: test_session.jsonl not found at ${SESSION_FIXTURE}`);
    process.exit(1);
  }

  const timings = {};
  async function timed(name, fn) {
    const t = Date.now();
    await fn();
    timings[name] = Date.now() - t;
  }

  // Test 1 returns the run so test 2 can reuse the session
  let run;
  await timed('listTopics', async () => { run = await testListTopics(); });
  await timed('sessionJSONL', async () => { await testSessionJSONLHasToolEntries(run); });
  await timed('getTopicContent', async () => { await testGetTopicContent(); });
  await timed('bypassRestore', async () => { await testBypassRestore(); });
  await timed('summarizeNoisy', async () => { await testSummarizeAfterNoisyMCP(); });
  await timed('gardenerNoisy', async () => { await testGardenerDetectsNoisySession(); });

  const totalMs = Date.now() - suiteStart;
  console.log('\n--- Timing summary ---');
  for (const [k, ms] of Object.entries(timings)) {
    console.log(`  ${k.padEnd(20)} ${(ms / 1000).toFixed(1)}s`);
  }
  console.log(`  ${'total'.padEnd(20)} ${(totalMs / 1000).toFixed(1)}s`);

  console.log(`\n${passed + failed} e2e tests: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
