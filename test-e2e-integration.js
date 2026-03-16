#!/usr/bin/env node
/**
 * test-e2e-integration.js — Playwright integration test for summarize_topic.
 *
 * Same structure as testSummarizeAfterNoisyMCP in test-e2e.js, but Phase 1
 * uses the compound-engineering Playwright MCP to generate real browser_snapshot
 * tool_result entries as the noisy content.
 *
 * Run: npm run test:e2e:integration
 * Requires: ANTHROPIC_API_KEY, claude CLI, compound-engineering plugin with Playwright MCP
 *
 * This is an expensive (~3-5 min) integration test. Run AFTER npm run test:e2e passes.
 */

'use strict';

const pty = require('node-pty');
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const http = require('http');

const CWD = __dirname;

let passed = 0;
let failed = 0;

function pass(name) { passed++; console.log(`  ✓ ${name}`); }
function fail(name, err) { failed++; console.log(`  ✗ ${name}\n    ${err}`); }

function readSessionEntries(sessionPath) {
  return fs.readFileSync(sessionPath, 'utf8')
    .split('\n').filter(l => l.trim())
    .map(l => { try { return JSON.parse(l); } catch (_) { return null; } })
    .filter(Boolean);
}

function findSessionPath(sessionId) {
  const claudeDir = path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(claudeDir)) return null;
  for (const proj of fs.readdirSync(claudeDir)) {
    const candidate = path.join(claudeDir, proj, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function getActiveChain(entries) {
  const byUuid = new Map(entries.map(e => [e.uuid, e]));
  const parents = new Set(entries.map(e => e.parentUuid).filter(Boolean));
  const tails = entries.filter(e => !parents.has(e.uuid));
  const tail = tails[tails.length - 1];
  if (!tail) return [];
  const chain = [];
  let cur = tail;
  while (cur) {
    chain.push(cur);
    cur = cur.parentUuid ? byUuid.get(cur.parentUuid) : null;
  }
  return chain;
}

/**
 * Start a tiny local HTTP server that returns HTML with known content.
 * Returns { server, url, SNAPSHOT_MARKER }.
 */
function startTestServer() {
  const SNAPSHOT_MARKER = `PLAYWRIGHT-TEST-MARKER-${Date.now()}`;
  const html = `<!DOCTYPE html><html><head><title>Test Page</title></head><body>
<h1>Integration Test Page</h1>
<p>Marker: ${SNAPSHOT_MARKER}</p>
<ul>${Array.from({ length: 50 }, (_, i) => `<li>Item ${i + 1}: data row with index ${i}</li>`).join('\n')}</ul>
</body></html>`;

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}/`, SNAPSHOT_MARKER });
    });
  });
}

async function testSummarizeAfterPlaywright() {
  const testName = 'summarize_topic compresses Playwright browser_snapshot into summary pair';
  console.log(`\nRunning: ${testName}`);

  // Start local HTTP test server
  let testServer, testUrl, SNAPSHOT_MARKER;
  try {
    ({ server: testServer, url: testUrl, SNAPSHOT_MARKER } = await startTestServer());
  } catch (err) {
    fail(testName, `Failed to start test HTTP server: ${err.message}`);
    return;
  }

  const claudeDir = path.join(CWD, '.claude');
  if (!fs.existsSync(claudeDir)) fs.mkdirSync(claudeDir);

  const summarizeMcpConfig = JSON.stringify({
    mcpServers: {
      'context-manager': {
        type: 'stdio',
        command: 'node',
        args: [path.join(CWD, 'context-mcp.js')],
      },
    },
  });

  // --- Phase 1: Agent browses the test page ---
  // Does NOT use --strict-mcp-config so it can inherit the Playwright MCP from the plugin.
  let phase1Run;
  try {
    const args = [
      '--output-format', 'stream-json', '--verbose',
      '--system-prompt', 'You are a test agent. Use the provided MCP tools exactly as instructed.',
      '--allowedTools', 'mcp__plugin_compound-engineering_pw__browser_navigate,mcp__plugin_compound-engineering_pw__browser_snapshot',
      '--print',
      `Navigate to ${testUrl} using browser_navigate, then call browser_snapshot to capture the page content. Report how many list items you see.`,
    ];
    phase1Run = await new Promise((resolve, reject) => {
      const proc = pty.spawn('claude', args, {
        name: 'xterm-256color', cols: 220, rows: 50,
        cwd: CWD, env: { ...process.env },
      });
      const lines = [];
      let sessionId = null;
      let resultObj = null;
      const timer = setTimeout(() => { try { proc.kill(); } catch (_) {} reject(new Error('Phase 1 timed out')); }, 180000);
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
    testServer.close();
    fail(testName, `Phase 1 spawn failed: ${err.message}`);
    return;
  } finally {
    testServer.close();
  }

  // Find and copy session
  const sessionPath = findSessionPath(phase1Run.sessionId);
  if (!sessionPath) {
    fail(testName, `Phase 1 session JSONL not found (sessionId=${phase1Run.sessionId})`);
    return;
  }

  const testCopyPath = path.join(claudeDir, `e2e-playwright-${Date.now()}.jsonl`);
  fs.copyFileSync(sessionPath, testCopyPath);

  const pre = readSessionEntries(testCopyPath);
  const preChain = getActiveChain(pre);
  const preChainLength = preChain.length;

  // Check marker is in pre chain
  const markerInChain = preChain.some(e => JSON.stringify(e).includes(SNAPSHOT_MARKER));
  if (!markerInChain) {
    console.log(`    [warn] snapshot marker not found in active chain — snapshot may not have been captured`);
  }

  // --- Phase 2: Summarizer ---
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
      `Find a topic that contains browser tool calls (look for 'browser', 'navigate', or 'snapshot' in topic names). ` +
      `Then call mcp__context-manager__summarize_topic with that topic_id and session_path="${testCopyPath}".`,
    ];
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

  // --- Phase 3: Assertions ---
  let allPassed = true;
  function check(label, cond, detail) {
    if (cond) { pass(label); } else { fail(label, detail || 'assertion failed'); allPassed = false; }
  }

  try {
    const post = readSessionEntries(testCopyPath);
    const postChain = getActiveChain(post);

    const summaryAssistant = postChain.find(e =>
      e.type === 'assistant' &&
      e.message?.stop_reason === 'tool_use' &&
      Array.isArray(e.message?.content) &&
      e.message.content.some(b => b.type === 'tool_use' && b.name === 'Agent' && b.input?.subagent_type === 'summarizer')
    );
    check('L1: summary assistant entry in active chain', !!summaryAssistant,
      'no assistant entry with stop_reason=tool_use + Agent/summarizer');

    const summaryToolUseId = summaryAssistant?.message?.content?.find(b => b.name === 'Agent')?.id;
    const summaryResult = postChain.find(e =>
      e.type === 'user' &&
      Array.isArray(e.message?.content) &&
      e.message.content.some(b => b.type === 'tool_result' && b.tool_use_id === summaryToolUseId)
    );
    check('L1: summary result entry in active chain', !!summaryResult,
      'no user entry with matching tool_result');

    check('L1: active chain shorter after summarization',
      postChain.length < preChainLength,
      `post chain ${postChain.length} >= pre chain ${preChainLength}`);

    check('L1: snapshot marker not in active chain after summarization',
      !postChain.some(e => JSON.stringify(e).includes(SNAPSHOT_MARKER)),
      'snapshot marker still in active chain — not orphaned');

    const resultContent = summaryResult?.message?.content?.find(b => b.type === 'tool_result');
    const summaryText = Array.isArray(resultContent?.content)
      ? resultContent.content.map(c => c.text || '').join('')
      : String(resultContent?.content || '');

    check('L2: summary text is non-empty', summaryText.length > 0, 'summary text is empty');
    check('L5: summary text > 50 chars', summaryText.length > 50, `summary too short: "${summaryText.slice(0, 100)}"`);
    check('L5: summary does not look like stub',
      !summaryText.toLowerCase().startsWith('no summary') && summaryText.trim().length > 10,
      `stub: "${summaryText.slice(0, 100)}"`);

    if (allPassed) pass(testName);
  } catch (err) {
    fail(testName, `Phase 3 threw: ${err.message}`);
  } finally {
    try { fs.unlinkSync(testCopyPath); } catch (_) {}
  }
}

async function main() {
  console.log('E2E Integration Tests — Playwright browser + summarize_topic');
  console.log('Note: spawns real claude processes + browser; expect ~3-5 min\n');

  await testSummarizeAfterPlaywright();

  console.log(`\n${passed + failed} integration tests: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
