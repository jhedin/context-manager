#!/usr/bin/env node
/**
 * test-noisy-mcp.js — Synthetic noisy MCP server for e2e testing.
 *
 * Exposes one tool: get_noisy_data
 * Returns a ~10KB deterministic blob with a known sentinel value.
 * Used by testSummarizeAfterNoisyMCP in test-e2e.js.
 */

'use strict';

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

const SENTINEL = 'SENTINEL-banana-smoothie-42';
const UNIQUE_MARKER = `NOISY-TOOL-UNIQUE-${Date.now()}`;
const ROW_COUNT = 200;

function generateNoisyBlob() {
  const lines = [`UNIQUE_MARKER: ${UNIQUE_MARKER}`, `SENTINEL: ${SENTINEL}`, ''];
  for (let i = 1; i <= ROW_COUNT; i++) {
    lines.push(`ROW-${i.toString().padStart(4, '0')}: data-entry value=${i * 37} tag=${SENTINEL} payload=${'x'.repeat(40)}`);
  }
  return lines.join('\n');
}

const server = new Server({ name: 'noisy', version: '1.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: 'get_noisy_data',
    description: 'Returns a large deterministic data blob for testing context summarization.',
    inputSchema: { type: 'object', properties: {} }
  }]
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === 'get_noisy_data') {
    const blob = generateNoisyBlob();
    return {
      content: [{ type: 'text', text: blob }]
    };
  }
  throw new Error(`Unknown tool: ${req.params.name}`);
});

const transport = new StdioServerTransport();
server.connect(transport).catch(err => {
  process.stderr.write(`noisy-mcp error: ${err.message}\n`);
  process.exit(1);
});
