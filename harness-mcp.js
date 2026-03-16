#!/usr/bin/env node
/**
 * harness-mcp.js — MCP server for testing Claude Code agents in a PTY
 *
 * Tools:
 *   spawn_agent(prompt, session_id?, cwd?, env?)  → run_id, session_id
 *   get_output(run_id, since_line?)               → buffered output lines so far
 *   send_input(run_id, text)                      → sends text + enter to PTY
 *   wait_for_result(run_id, timeout_ms?)          → blocks until done, returns output
 *   kill_agent(run_id)                            → kills PTY
 *   list_agents()                                 → active run_ids
 *   read_session(session_id)                      → last N entries from session JSONL
 */

'use strict';

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const pty = require('node-pty');
const fs = require('fs');
const path = require('path');
const os = require('os');

const server = new McpServer({ name: 'harness', version: '1.0.0' });

// Active PTY sessions keyed by run_id
const runs = new Map();
let nextRunId = 1;

function makeRunId() {
  return `run-${nextRunId++}`;
}

// Find the session JSONL path for a session_id
function sessionPath(sessionId) {
  // Claude stores sessions under ~/.claude/projects/<encoded-cwd>/
  // We can find it by searching
  const claudeDir = path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(claudeDir)) return null;
  for (const proj of fs.readdirSync(claudeDir)) {
    const candidate = path.join(claudeDir, proj, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// Spawn a claude agent in a PTY
server.tool(
  'spawn_agent',
  {
    prompt: z.string().describe('Initial prompt to send to the agent'),
    session_id: z.string().optional().describe('Resume an existing session'),
    cwd: z.string().optional().describe('Working directory (defaults to current)'),
    print_mode: z.boolean().optional().describe('Use --print (non-interactive, no AskUserQuestion) for simple runs'),
  },
  async ({ prompt, session_id, cwd: cwdOpt, print_mode }) => {
    const runId = makeRunId();
    const cwd = cwdOpt || process.cwd();

    const args = ['--output-format', 'stream-json', '--verbose'];
    if (print_mode) {
      args.push('--print', prompt);
    }
    // Interactive mode: no --input-format flag; claude renders its TUI and we
    // send the prompt as plain text after detecting the ready prompt (❯)
    if (session_id) {
      args.push('--resume', session_id);
    }

    const ptyProc = pty.spawn('claude', args, {
      name: 'xterm-256color',
      cols: 220,
      rows: 50,
      cwd,
      env: { ...process.env },
    });

    const lines = [];
    let capturedSessionId = session_id || null;
    let done = false;
    let exitCode = null;
    const doneCallbacks = [];

    ptyProc.onData((data) => {
      // Split on newlines, handle partial lines
      const parts = data.split('\n');
      for (const part of parts) {
        const line = part.replace(/\r/g, '').trim();
        if (!line) continue;
        lines.push(line);

        // Try to parse JSON events for session_id extraction
        try {
          const obj = JSON.parse(line);
          // session_id appears in hook events before init — grab it early
          if (obj.session_id && !capturedSessionId) {
            capturedSessionId = obj.session_id;
          }
          if (obj.type === 'result') {
            done = true;
            for (const cb of doneCallbacks) cb(lines);
            doneCallbacks.length = 0;
          }
        } catch (_) {
          // Not JSON — raw terminal output, still buffered
        }
      }
    });

    ptyProc.onExit(({ exitCode: code }) => {
      exitCode = code;
      done = true;
      for (const cb of doneCallbacks) cb(lines);
      doneCallbacks.length = 0;
    });

    // Track whether we've sent the initial prompt in interactive mode
    let promptSent = false;

    // In interactive mode, watch for the ❯ ready prompt, then send plain text
    if (!print_mode) {
      ptyProc.onData((data) => {
        if (!promptSent && data.includes('❯')) {
          promptSent = true;
          // Small delay to let the input box settle
          setTimeout(() => ptyProc.write(prompt + '\r'), 100);
        }
      });
    }

    runs.set(runId, { ptyProc, lines, done: () => done, exitCode: () => exitCode, doneCallbacks, sessionId: () => capturedSessionId });

    return {
      content: [{ type: 'text', text: JSON.stringify({ run_id: runId, session_id: capturedSessionId, status: 'spawned' }) }]
    };
  }
);

// Get buffered output lines
server.tool(
  'get_output',
  {
    run_id: z.string(),
    since_line: z.number().optional().describe('Return only lines from this index onward'),
    raw: z.boolean().optional().describe('Return raw terminal output including ANSI; default strips to JSON-parseable lines only'),
  },
  async ({ run_id, since_line = 0, raw = false }) => {
    const run = runs.get(run_id);
    if (!run) return { content: [{ type: 'text', text: `Unknown run_id: ${run_id}` }] };

    let lines = run.lines.slice(since_line);
    if (!raw) {
      // Filter to JSON-parseable lines, skip hook noise
      lines = lines.filter(l => {
        try {
          const obj = JSON.parse(l);
          const sub = obj.subtype || '';
          return !(obj.type === 'system' && (sub === 'hook_started' || sub === 'hook_response'));
        } catch (_) { return false; }
      });
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          run_id,
          session_id: run.sessionId(),
          done: run.done(),
          total_lines: run.lines.length,
          returned_from: since_line,
          lines,
        })
      }]
    };
  }
);

// Send input to the PTY (for answering AskUserQuestion prompts)
server.tool(
  'send_input',
  {
    run_id: z.string(),
    text: z.string().describe('Text to send. Use arrow keys like \\x1b[A (up) \\x1b[B (down). Enter is automatic.'),
    no_enter: z.boolean().optional().describe('Send text without appending enter'),
  },
  async ({ run_id, text, no_enter = false }) => {
    const run = runs.get(run_id);
    if (!run) return { content: [{ type: 'text', text: `Unknown run_id: ${run_id}` }] };
    if (run.done()) return { content: [{ type: 'text', text: 'Agent already finished' }] };

    run.ptyProc.write(no_enter ? text : text + '\r');
    return { content: [{ type: 'text', text: 'sent' }] };
  }
);

// Wait for the agent to finish (up to timeout_ms)
server.tool(
  'wait_for_result',
  {
    run_id: z.string(),
    timeout_ms: z.number().optional().describe('Max wait in ms (default 120000)'),
  },
  async ({ run_id, timeout_ms = 120000 }) => {
    const run = runs.get(run_id);
    if (!run) return { content: [{ type: 'text', text: `Unknown run_id: ${run_id}` }] };

    if (!run.done()) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout')), timeout_ms);
        run.doneCallbacks.push(() => { clearTimeout(timer); resolve(); });
      }).catch(e => e.message);
    }

    // Find the result event
    const resultLine = run.lines.slice().reverse().find(l => {
      try { return JSON.parse(l).type === 'result'; } catch (_) { return false; }
    });
    const result = resultLine ? JSON.parse(resultLine) : null;

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          run_id,
          session_id: run.sessionId(),
          done: run.done(),
          result: result?.result,
          stop_reason: result?.stop_reason,
          is_error: result?.is_error,
          total_lines: run.lines.length,
        })
      }]
    };
  }
);

// Kill a running agent
server.tool(
  'kill_agent',
  { run_id: z.string() },
  async ({ run_id }) => {
    const run = runs.get(run_id);
    if (!run) return { content: [{ type: 'text', text: `Unknown run_id: ${run_id}` }] };
    try { run.ptyProc.kill(); } catch (_) {}
    runs.delete(run_id);
    return { content: [{ type: 'text', text: `killed ${run_id}` }] };
  }
);

// List active runs
server.tool(
  'list_agents',
  {},
  async () => {
    const active = [];
    for (const [id, run] of runs) {
      active.push({ run_id: id, done: run.done(), session_id: run.sessionId(), lines: run.lines.length });
    }
    return { content: [{ type: 'text', text: JSON.stringify(active) }] };
  }
);

// Read session JSONL entries for verification
server.tool(
  'read_session',
  {
    session_id: z.string(),
    last_n: z.number().optional().describe('Return only last N entries (default 50)'),
    filter_type: z.string().optional().describe('Filter to entries of this type (assistant/user/system)'),
  },
  async ({ session_id, last_n = 50, filter_type }) => {
    const p = sessionPath(session_id);
    if (!p) return { content: [{ type: 'text', text: `Session not found: ${session_id}` }] };

    const raw = fs.readFileSync(p, 'utf8');
    let entries = raw.split('\n').filter(l => l.trim()).map(l => {
      try { return JSON.parse(l); } catch (_) { return null; }
    }).filter(Boolean);

    if (filter_type) entries = entries.filter(e => e.type === filter_type);
    entries = entries.slice(-last_n);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ session_id, path: p, count: entries.length, entries })
      }]
    };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
