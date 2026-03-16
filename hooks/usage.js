'use strict';

const MODEL_LIMITS = {
  'claude-opus-4-6':   1000000,
  'claude-sonnet-4-6': 1000000,
  'claude-sonnet-4-5': 1000000,
  'claude-haiku-4-5':   200000,
  // Legacy model IDs
  'claude-3-7-sonnet':  200000,
  'claude-3-5-sonnet':  200000,
  'claude-3-5-haiku':   200000,
};

/**
 * Given an array of raw JSONL line strings, walk backwards to find the last
 * entry with message.usage and return token usage info.
 *
 * Returns { usagePct, currentUsage, maxTokens, modelId } or null if no usage found.
 */
function getTokenUsage(lines) {
  let usage = null;
  let modelId = '';

  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]);
      if (entry.message?.usage) {
        usage = entry.message.usage;
        modelId = entry.message.model || '';
        break;
      }
    } catch (_) {}
  }

  if (!usage) return null;

  let maxTokens = parseInt(process.env.CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE) || 0;
  if (!maxTokens) {
    const modelMatch = Object.keys(MODEL_LIMITS).find(m => modelId.includes(m));
    maxTokens = modelMatch ? MODEL_LIMITS[modelMatch] : 1000000;
  }

  const currentUsage = usage.input_tokens;
  const usagePct = (currentUsage / maxTokens) * 100;

  return { usagePct, currentUsage, maxTokens, modelId };
}

module.exports = { getTokenUsage, MODEL_LIMITS };
