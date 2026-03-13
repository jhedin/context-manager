#!/bin/bash

# setup.sh - Custom Context Manager (V1) Installer

echo "--- Initializing Custom Context Manager ---"

# 1. Install Dependencies
echo "[1/3] Installing Node dependencies..."
npm install @anthropic-ai/claude-code enquirer --save-dev

# 2. Check for Claude Login
echo "[2/3] Checking Claude authentication..."
if ! claude config get > /dev/null 2>&1; then
    echo "Warning: No Claude session found. You may need to run 'claude login' first."
fi

# 3. Finalizing
echo "[3/3] Finalizing setup..."
chmod +x agent_manager.js

echo "------------------------------------------------"
echo "Setup Complete!"
echo ""
echo "To start your custom managed session, run:"
echo "node agent_manager.js"
echo ""
echo "Once inside, use:"
echo "- /compact-ui  : To manually prune history (DAG Bypass)"
echo "- /help        : To see all standard Claude commands"
echo "------------------------------------------------"
