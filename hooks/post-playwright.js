#!/usr/bin/env node
'use strict';

/**
 * PostToolUse hook for playwright MCP tools.
 *
 * Two transforms applied before the result is shown to the agent:
 *
 * 1. Strip image blocks unconditionally — base64 screenshots are ~100KB blobs
 *    that Claude Code does not expose as vision input to the model. They're
 *    pure waste in the session. The file still exists on disk.
 *
 * 2. Ask Haiku to compress the ARIA snapshot text — the YAML accessibility
 *    tree from browser_snapshot/browser_navigate can be 20-60KB. Haiku gets
 *    the tool name, the tool input (what we were trying to do), and the raw
 *    snapshot, and returns a condensed version that keeps ref= values and
 *    actionable elements while dropping generic wrappers, upsell noise, etc.
 */

const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');

const LOG_FILE = '.claude/hooks/post-playwright.log';

function log(msg) {
  try {
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
  } catch (_) {}
}

async function callHaiku(systemPrompt, userContent) {
  const client = new Anthropic();
  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 16000,
    system: systemPrompt,
    messages: [{ role: 'user', content: userContent }]
  });
  const text = response.content.find(b => b.type === 'text')?.text;
  if (!text) throw new Error('Haiku returned no text block');
  return text;
}

/**
 * Deterministic pre-strip of known noise patterns before sending to Haiku.
 * Removes things that are unambiguously useless and can be identified by
 * pattern, reducing input size so Haiku's output budget is sufficient.
 */
function preStripSnapshot(text) {
  return text
    // Strip long tracking/query URLs on /url: lines — keep the path, drop ?query
    .replace(/(^\s*- \/url: https?:\/\/[^\n?]+)\?[^\n]*/gm, '$1')
    // Strip character-count paragraphs like "5/50" or "0/220"
    .replace(/^\s*- paragraph \[ref=\w+\]: \d+\/\d+\n/gm, '')
    // Strip lines that are purely decorative img refs with no alt text
    // e.g. "      - img [ref=e390]" (no trailing text after the ref)
    .replace(/^\s*- img \[ref=\w+\]\s*\n/gm, '')
    // Strip "figure [ref=eNNN]" with no children (decorator/spacer figures)
    .replace(/^\s*- figure \[ref=\w+\]\s*\n/gm, '');
}

async function main() {
  let input;
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch (e) {
    log(`Failed to parse stdin: ${e.message}`);
    process.exit(0);
  }

  const { tool_name, tool_input, tool_response } = input;
  log(`FIRED for ${tool_name} (input keys: ${Object.keys(tool_input || {}).join(', ')})`);

  // tool_response for MCP tools is an array of content blocks
  let blocks;
  try {
    blocks = Array.isArray(tool_response) ? tool_response :
             (typeof tool_response === 'string' ? JSON.parse(tool_response) : tool_response);
    if (!Array.isArray(blocks)) {
      log('tool_response is not an array, passing through');
      process.exit(0);
    }
  } catch (e) {
    log(`Could not parse tool_response: ${e.message}`);
    process.exit(0);
  }

  // --- Transform 1: strip image blocks ---
  const originalImageCount = blocks.filter(b => b.type === 'image').length;
  blocks = blocks.filter(b => b.type !== 'image');
  if (originalImageCount > 0) {
    log(`Stripped ${originalImageCount} image block(s)`);
  }

  // --- Transform 2: ask Haiku to compress snapshot text ---
  // Only worth doing if there's a meaningful amount of ARIA text
  const textBlock = blocks.find(b => b.type === 'text' && b.text);
  const hasSnapshot = textBlock && textBlock.text.includes('### Snapshot');
  const textSize = textBlock ? textBlock.text.length : 0;
  const HAIKU_THRESHOLD = 2000; // chars — below this, not worth the API call

  if (hasSnapshot && textSize > HAIKU_THRESHOLD) {
    // Pre-strip deterministic noise before sending to Haiku, to keep the
    // input small enough that Haiku can actually reproduce the output.
    const preStripped = preStripSnapshot(textBlock.text);
    log(`Pre-strip: ${textSize} → ${preStripped.length} chars`);

    log(`Sending ${preStripped.length} chars to Haiku`);

    // Build context about what the agent was trying to do
    const inputSummary = Object.entries(tool_input || {})
      .map(([k, v]) => `${k}: ${String(v).substring(0, 200)}`)
      .join(', ') || '(no input)';

    const systemPrompt = `You compress Playwright ARIA snapshots for an AI agent that needs to interact with a page.
The agent uses ref= values (like [ref=e42]) to click and fill elements — preserve refs on interactive elements.

Be aggressive. Your goal is a 5-10x size reduction. You may drop entire subtrees.

DROP entirely:
- Navigation bars, headers, footers not relevant to the task
- Upsell/premium/subscription banners and their entire subtrees
- Cookie consent, notification banners
- Sidebar content unrelated to the main task area
- Decorative structure (generic wrappers, figures, imgs) with no interactive children
- Duplicate or repeated link text
- Any subtree where the only content is "0 notifications" or similar noise

KEEP (with their refs):
- The active dialog, form, or main content area
- All interactive elements: buttons, links, inputs, selects, textboxes, comboboxes
- Labels and placeholder text for form fields
- Current values in filled fields
- Page URL, title, and any error/warning counts

Flatten deeply nested generic wrappers into their first meaningful child.
Return only the compressed snapshot, preserving the ### headers and yaml code block format. No commentary.`;

    const userContent = `Tool: ${tool_name}
Tool input: ${inputSummary}

Raw output to compress:
${preStripped}`;

    try {
      const compressed = await callHaiku(systemPrompt, userContent);
      const ratio = Math.round((1 - compressed.length / textSize) * 100);
      log(`Haiku compressed ${textSize} → ${compressed.length} chars (${ratio}% reduction)`);
      blocks = blocks.map(b =>
        (b === textBlock) ? { ...b, text: compressed } : b
      );
    } catch (e) {
      log(`Haiku call failed (${e.message}), using pre-stripped version`);
      // Use pre-stripped at minimum — better than original even without Haiku
      blocks = blocks.map(b =>
        (b === textBlock) ? { ...b, text: preStripped } : b
      );
    }
  } else if (textSize > 0) {
    log(`Text is ${textSize} chars (below threshold or no snapshot), skipping Haiku`);
  }

  // Output the modified result
  const output = {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      updatedMCPToolOutput: blocks
    }
  };

  process.stdout.write(JSON.stringify(output));
  log(`Done. Output blocks: ${blocks.length}`);
}

main().catch(e => {
  log(`FATAL: ${e.message}\n${e.stack}`);
  process.exit(0); // Never crash — pass through silently
});
