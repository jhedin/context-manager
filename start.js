#!/usr/bin/env node
// Bootstrap: ensure deps are installed before starting the MCP server.
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const root = __dirname;
const nodeModules = path.join(root, 'node_modules');
const sdkEntry = path.join(nodeModules, '@modelcontextprotocol', 'sdk', 'server', 'index.js');

if (!fs.existsSync(sdkEntry)) {
  process.stderr.write('[context-manager] Installing dependencies...\n');
  execSync('npm install --prefer-offline --no-audit --no-fund', { cwd: root, stdio: 'inherit' });
}

require('./context-mcp.js');
