const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { CallToolRequestSchema, ListToolsRequestSchema } = require("@modelcontextprotocol/sdk/types.js");
const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');

const server = new Server(
  { name: "context-manager-mcp", version: "3.0.0" },
  { capabilities: { tools: {} } }
);

const path = require('path');

const SESSION_PATH_FILE = '.claude/session_path.txt';
const STAGED_FUTURE_FILE = '.claude/staged_future.jsonl';
const SIDECAR_FILE = '.claude/context_sidecar.json';
const REPARENT_MARKER_FILE = '.claude/pending_reparent.json';
const BACKUP_DIR = '.claude/backups';
const MAX_BACKUPS = 20;
const BACKUP_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function getAutoSessionPath() {
  if (fs.existsSync(SESSION_PATH_FILE)) {
    return fs.readFileSync(SESSION_PATH_FILE, 'utf8').trim();
  }
  return null;
}

/**
 * Validate that a session path is a .jsonl file inside a known Claude directory.
 * Prevents path traversal attacks via user-provided session_path.
 */
function validateSessionPath(filePath) {
  const resolved = path.resolve(filePath);
  if (!resolved.endsWith('.jsonl')) return 'Session path must be a .jsonl file.';
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const allowedPrefixes = [
    path.join(home, '.claude'),
    path.resolve('.claude'),
    path.resolve('test_session.jsonl'), // allow test fixture
  ];
  if (!allowedPrefixes.some(p => resolved.startsWith(p) || resolved === p)) {
    return `Session path must be inside a .claude directory: ${resolved}`;
  }
  return null;
}

function readHistory(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(l => l.trim())
    .map(l => JSON.parse(l));
}

/**
 * Back up a session file before modifying it. Uses cp to preserve the original
 * file. Keeps MAX_BACKUPS most recent backups, pruning older ones.
 */
function backupSessionFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

  const basename = path.basename(filePath, '.jsonl');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupName = `${basename}_${timestamp}.jsonl`;
  const backupPath = path.join(BACKUP_DIR, backupName);

  // Use copyFileSync — this creates a separate file, not a rename.
  fs.copyFileSync(filePath, backupPath);

  // Prune: remove backups older than TTL, then cap at MAX_BACKUPS
  const now = Date.now();
  const allBackups = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith(basename + '_') && f.endsWith('.jsonl'))
    .sort()
    .reverse();

  for (let i = 0; i < allBackups.length; i++) {
    const fullPath = path.join(BACKUP_DIR, allBackups[i]);
    const age = now - fs.statSync(fullPath).mtimeMs;
    if (age > BACKUP_TTL_MS || i >= MAX_BACKUPS) {
      fs.unlinkSync(fullPath);
    }
  }

  return backupPath;
}

/**
 * List available backups for a session file.
 */
function listBackups(filePath) {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  const basename = path.basename(filePath, '.jsonl');
  return fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith(basename + '_') && f.endsWith('.jsonl'))
    .sort()
    .reverse()
    .map(f => {
      const fullPath = path.join(BACKUP_DIR, f);
      const stat = fs.statSync(fullPath);
      // Estimate entry count from file size (~250 bytes/entry avg) instead of
      // reading every backup file. Avoids 100MB+ I/O for 20 backups.
      const estimatedEntries = Math.round(stat.size / 250);
      return { name: f, path: fullPath, size: stat.size, estimatedEntries, mtime: stat.mtime.toISOString() };
    });
}

function safeWriteHistory(filePath, entries) {
  // Write in-place to preserve the inode. Using rename() would create a new
  // inode, causing Claude Code's open fd to point to a ghost file — all
  // subsequent appends would be lost. Truncate+write keeps the same inode.
  //
  // Backups are handled by the PreToolUse hook (pre-backup.js), which fires
  // before this tool even executes. This way even a crash mid-write is safe.
  try {
    fs.writeFileSync(filePath, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
    return { ok: true };
  } catch (err) {
    return { error: `Failed to write session file: ${err.message}` };
  }
}

/**
 * Check for in-flight async work by scanning the transcript for:
 * 1. tool_use blocks without corresponding tool_result
 * 2. Unmatched subagent_start / subagent_stop system entries
 * 3. Unmatched background_task_start / background_task_complete entries
 *
 * Returns { pendingTools: Set, activeSubagents: number, activeBackgroundTasks: number }
 */
function checkForInflightWork(entries) {
  const pendingTools = new Set();
  let subagentStarts = 0;
  let subagentStops = 0;
  let bgTaskStarts = 0;
  let bgTaskStops = 0;

  for (const entry of entries) {
    // Check system entries for subagent/background task lifecycle
    if (entry.type === 'system') {
      const subtype = entry.subtype || entry.message?.subtype;
      if (subtype === 'subagent_start') subagentStarts++;
      else if (subtype === 'subagent_stop') subagentStops++;
      else if (subtype === 'background_task_start') bgTaskStarts++;
      else if (subtype === 'background_task_complete') bgTaskStops++;
    }

    // Check message content for unmatched tool_use / tool_result
    if (!entry.message?.content) continue;
    for (const block of entry.message.content) {
      if (block.type === 'tool_use') {
        pendingTools.add(block.id);
      } else if (block.type === 'tool_result') {
        pendingTools.delete(block.tool_use_id);
      }
    }
  }

  return {
    pendingTools,
    activeSubagents: Math.max(0, subagentStarts - subagentStops),
    activeBackgroundTasks: Math.max(0, bgTaskStarts - bgTaskStops)
  };
}

function buildUuidMap(history) {
  const map = new Map();
  for (const entry of history) {
    map.set(entry.uuid, entry);
  }
  return map;
}

function findActiveTail(history) {
  // The active tail is the entry whose UUID is not referenced as any other entry's parentUuid.
  // Skip entries without a uuid (file-history-snapshot, queue-operation, etc.)
  const childCount = new Map();
  for (const e of history) {
    if (e.parentUuid) childCount.set(e.parentUuid, (childCount.get(e.parentUuid) || 0) + 1);
  }
  // Walk backwards — first entry with a uuid, no children, and not disconnected
  // from the chain (dormant summaries and orphaned sidechains have parentUuid: null
  // but aren't real chain members).
  for (let i = history.length - 1; i >= 0; i--) {
    const e = history[i];
    if (e.uuid && !childCount.has(e.uuid) && !e.dormantSummaryFor && !e.isSidechain) return e;
  }
  return history[history.length - 1]; // fallback
}

function getActiveChainUuids(history) {
  const uuidMap = buildUuidMap(history);
  const activeUuids = new Set();
  let curr = findActiveTail(history);
  while (curr) {
    activeUuids.add(curr.uuid);
    curr = curr.parentUuid ? uuidMap.get(curr.parentUuid) : null;
  }
  return activeUuids;
}

function getTextContent(entry) {
  if (!entry.message?.content) return "";
  for (const block of entry.message.content) {
    if (block.type === 'text') return block.text;
  }
  return "";
}

/**
 * Analyze an entry for content characteristics: size, tool heaviness, content types.
 */
function analyzeEntry(entry) {
  // Only count message.content toward tokens — metadata (uuid, timestamps, etc.) is not sent to the model
  let contentChars = 0;
  let toolUseCount = 0;
  let toolResultCount = 0;
  let toolResultChars = 0;
  let hasLargeToolResult = false;
  let toolNames = [];

  if (entry.message?.content) {
    for (const block of entry.message.content) {
      if (block.type === 'text' && block.text) {
        contentChars += block.text.length;
      } else if (block.type === 'tool_use') {
        toolUseCount++;
        if (block.name) toolNames.push(block.name);
        // Count the input as content
        contentChars += JSON.stringify(block.input || {}).length;
      } else if (block.type === 'tool_result') {
        toolResultCount++;
        const resultSize = typeof block.content === 'string'
          ? block.content.length
          : JSON.stringify(block.content).length;
        toolResultChars += resultSize;
        contentChars += resultSize;
        if (resultSize > 4000) hasLargeToolResult = true;
      }
    }
  }

  return { contentChars, toolUseCount, toolResultCount, toolResultChars, hasLargeToolResult, toolNames };
}

function getTopics(history) {
  const activeUuids = getActiveChainUuids(history);

  const topics = [];
  // Use first message UUID as stable topic ID (survives re-scans)
  let currentTopic = {
    id: history[0]?.uuid || '0', name: "[Start] Initial Context", messages: [], isOrphan: false,
    contentChars: 0, toolUses: 0, toolResults: 0, toolResultChars: 0,
    hasLargeToolResults: false, toolNames: new Set()
  };

  history.forEach((entry, idx) => {
    // Skip dormant summary entries — they're pre-built summaries sitting
    // outside the chain, not real conversation content.
    if (entry.dormantSummaryFor) return;

    const text = getTextContent(entry);
    const isTopicShift = text.toLowerCase().startsWith('now ') ||
                         text.toLowerCase().startsWith('next ') ||
                         !entry.parentUuid;

    if (isTopicShift && idx > 0) {
      currentTopic.toolNames = [...currentTopic.toolNames];
      topics.push(currentTopic);
      const shortName = text.split(/[.!?]/)[0].substring(0, 40) || "Phase Start";
      currentTopic = {
        id: entry.uuid,  // Stable: UUID of first message in topic
        name: `[Topic] ${shortName}`,
        messages: [],
        isOrphan: !activeUuids.has(entry.uuid),
        contentChars: 0, toolUses: 0, toolResults: 0, toolResultChars: 0,
        hasLargeToolResults: false, toolNames: new Set()
      };
    }

    const stats = analyzeEntry(entry);
    currentTopic.contentChars += stats.contentChars;
    currentTopic.toolUses += stats.toolUseCount;
    currentTopic.toolResults += stats.toolResultCount;
    currentTopic.toolResultChars += stats.toolResultChars;
    if (stats.hasLargeToolResult) currentTopic.hasLargeToolResults = true;
    for (const name of stats.toolNames) currentTopic.toolNames.add(name);

    currentTopic.messages.push({ uuid: entry.uuid, parentUuid: entry.parentUuid, text });
  });

  currentTopic.toolNames = [...currentTopic.toolNames];
  topics.push(currentTopic);
  return topics;
}

/**
 * Score topics for pruning priority. Higher = better candidate to remove.
 * Factors: size, tool-heaviness, iteration patterns (Read/Edit/Bash loops).
 */
function scorePruningCandidates(topics) {
  // Count active (non-orphan) topics for recency calculation
  const activeTopics = topics.filter(t => !t.isOrphan);
  const activeCount = activeTopics.length;
  // Pre-build index map to avoid O(n²) indexOf inside the map loop
  const activeIndexMap = new Map(activeTopics.map((t, i) => [t, i]));

  return topics.map((t, idx) => {
    let score = 0;
    const estimatedTokens = Math.round(t.contentChars / 4);

    // Size: bigger = more valuable to prune
    score += estimatedTokens / 1000;

    // Tool-heavy topics (lots of Read/Bash output) are prime targets
    if (t.toolResultChars > 10000) score += 20;
    if (t.hasLargeToolResults) score += 15;

    // Iteration loops: topics with many tool uses relative to messages
    const toolDensity = t.messages.length > 0 ? t.toolUses / t.messages.length : 0;
    if (toolDensity > 2) score += 10;

    // Bash-heavy or Read-heavy topics (exploration/debugging)
    const heavyTools = ['Bash', 'Read', 'Grep', 'Glob', 'Agent'];
    const hasHeavyTools = t.toolNames.some(n => heavyTools.includes(n));
    if (hasHeavyTools && t.toolResults > 3) score += 10;

    // Recency: recent topics are more valuable to keep. The last ~25% of
    // active topics get a penalty (lower prune score), older topics get a
    // bonus. The first topic (initial context) is protected too.
    if (!t.isOrphan && activeCount > 4) {
      const activeIdx = activeIndexMap.get(t) ?? -1;
      const position = activeIdx / (activeCount - 1); // 0.0 = oldest, 1.0 = newest
      if (activeIdx === 0) {
        // First topic (initial context) — protect it
        score -= 20;
      } else if (position < 0.5) {
        // Older half — bonus (good prune candidates, outcomes in code)
        score += 15 * (1 - position);
      } else {
        // Newer half — penalty (fresh context, still relevant)
        score -= 20 * position;
      }
    }

    // Orphans are already disconnected — low priority to "bypass" since they don't cost context
    if (t.isOrphan) score = 0;

    // Summary topics are already condensed — don't recommend pruning them further
    const firstMsg = t.messages[0];
    const firstText = firstMsg?.text || '';
    const isSummaryPair = firstMsg?.message?.content?.some(b => b.type === 'tool_use' && b.name === 'Agent');
    if (firstText.startsWith('[SUMMARY of') || isSummaryPair) score = 0;

    return { ...t, pruneScore: Math.round(score), estimatedTokens };
  });
}

// --- Sidecar for audit logging ---

class Sidecar {
  static get() {
    if (!fs.existsSync(SIDECAR_FILE)) return { operations: [] };
    return JSON.parse(fs.readFileSync(SIDECAR_FILE, 'utf8'));
  }
  static save(data) {
    fs.writeFileSync(SIDECAR_FILE, JSON.stringify(data, null, 2));
  }
  static log(operation, details) {
    const data = this.get();
    data.operations.push({ timestamp: new Date().toISOString(), operation, ...details });
    this.save(data);
  }
}

// --- DAG operations (pure logic, no interactive prompts) ---

function bypassTopic(history, topic) {
  const topicUuids = new Set(topic.messages.map(m => m.uuid));
  const grandparentUuid = topic.messages[0].parentUuid;
  const lastMsgUuid = topic.messages[topic.messages.length - 1].uuid;

  Sidecar.log('BYPASS', { topic: topic.name, uuids: [...topicUuids], reParentedTo: grandparentUuid });

  // Don't delete the topic messages — just reparent around them so they become
  // orphans. This preserves them in the file for potential restore later.
  // The downstream entry that chained off the topic's last message now points
  // to the topic's grandparent, skipping over the topic.
  return history.map(entry => {
    if (entry.parentUuid === lastMsgUuid && !topicUuids.has(entry.uuid)) {
      return { ...entry, parentUuid: grandparentUuid };
    }
    return entry;
  });
}

function restoreTopic(history, topic) {
  // Undo a bypass or summarize by re-inserting an orphaned topic back into the
  // active chain.
  const grandparentUuid = topic.messages[0].parentUuid;

  if (!topic.isOrphan) {
    return { error: `Topic "${topic.name}" is not orphaned — nothing to restore.` };
  }

  // Check if a summary pair replaced this topic. The summary assistant entry
  // has parentUuid == grandparent and a tool_use block with name 'Agent'.
  // The result entry is parented to the assistant entry and has a tool_result.
  // Legacy summaries (pre-pair) had a text block containing '[SUMMARY of'.
  const summaryAssistant = history.find(e =>
    e.parentUuid === grandparentUuid &&
    e.message?.content?.some(b =>
      (b.type === 'tool_use' && b.name === 'Agent') ||
      (b.type === 'text' && b.text?.includes('[SUMMARY of'))
    )
  );
  const summaryResult = summaryAssistant
    ? history.find(e => e.parentUuid === summaryAssistant.uuid &&
        e.message?.content?.some(b => b.type === 'tool_result'))
    : null;
  // The tail of the summary pair: downstream entry points here
  const summaryTail = summaryResult || summaryAssistant;

  // Filter out the summary entries from topic messages (getTopics may have grouped them in)
  const summaryUuids = new Set([summaryAssistant?.uuid, summaryResult?.uuid].filter(Boolean));
  const realMessages = topic.messages.filter(m => !summaryUuids.has(m.uuid));
  const topicUuids = new Set(realMessages.map(m => m.uuid));
  const firstMsg = realMessages[0];
  const lastMsg = realMessages[realMessages.length - 1];

  Sidecar.log('RESTORE', { topic: topic.name, lastMsgUuid: lastMsg.uuid, grandparentUuid, hadSummary: !!summaryAssistant });

  return history.map(entry => {
    // Orphan the summary assistant entry
    if (summaryAssistant && entry.uuid === summaryAssistant.uuid) {
      return { ...entry, parentUuid: null, isSidechain: true };
    }
    // Orphan the summary result entry (keep its parentUuid pointing to assistant so it stays grouped)
    if (summaryResult && entry.uuid === summaryResult.uuid) {
      return { ...entry, isSidechain: true };
    }
    // Find the entry that was reparented to skip this topic.
    // For bypass: it points to grandparent. For summarize: it points to summary tail.
    // Either way, point it back to the topic's last message.
    if (entry.parentUuid === grandparentUuid && !topicUuids.has(entry.uuid) && !summaryUuids.has(entry.uuid)) {
      return { ...entry, parentUuid: lastMsg.uuid };
    }
    if (summaryTail && entry.parentUuid === summaryTail.uuid && !topicUuids.has(entry.uuid) && !summaryUuids.has(entry.uuid)) {
      return { ...entry, parentUuid: lastMsg.uuid };
    }
    return entry;
  });
}

/**
 * Create a dormant summary as a subagent pair — two entries appended to the
 * file but NOT linked into the active chain. Both have parentUuid: null and
 * dormantSummaryFor pointing to the original topic's first-message UUID.
 *
 * Entry 1 (assistant): tool_use block simulating an Agent call to a summarizer subagent.
 * Entry 2 (user): tool_result block with the summary text, parented to entry 1.
 *
 * When activated, entry 1 is linked to the topic's grandparent, entry 2 to entry 1,
 * and the downstream chain entry is reparented to entry 2.
 *
 * Returns the new history array with both dormant entries appended.
 */
function createDormantSummary(history, topic, summaryText, sessionFilePath) {
  const { v4: uuidv4 } = require('uuid');
  const topicUuids = new Set(topic.messages.map(m => m.uuid));
  const templateEntry = history.find(e => topicUuids.has(e.uuid)) || history[0];
  const toolUseId = `toolu_summary_${uuidv4().replace(/-/g, '').substring(0, 20)}`;
  const assistantUuid = uuidv4();
  const resultUuid = uuidv4();
  const agentId = uuidv4().replace(/-/g, '').substring(0, 17);
  const promptId = uuidv4();
  const now = new Date().toISOString();

  const summaryText_ = `[SUMMARY of "${topic.name}" (original: ${topic.id}) — ${topic.messages.length} messages condensed]\n\n${summaryText}`;

  // Entry 1: assistant tool_use (appears as subagent dispatch in UI)
  const assistantEntry = {
    uuid: assistantUuid,
    parentUuid: null,
    dormantSummaryFor: topic.id,
    type: 'assistant',
    sessionId: templateEntry.sessionId,
    timestamp: now,
    cwd: templateEntry.cwd,
    version: templateEntry.version,
    message: {
      model: 'claude-opus-4-6',
      role: 'assistant',
      stop_reason: 'tool_use',
      content: [{
        type: 'tool_use',
        id: toolUseId,
        name: 'Agent',
        input: {
          description: `Summarize topic: ${topic.name}`,
          subagent_type: 'summarizer',
          prompt: `Summarize this topic for context compression: ${topic.name}`
        },
        caller: { type: 'direct' }
      }]
    }
  };

  // Entry 2: user tool_result (contains the actual summary text)
  const resultEntry = {
    uuid: resultUuid,
    parentUuid: assistantUuid,
    dormantSummaryFor: topic.id,
    promptId,
    type: 'user',
    sessionId: templateEntry.sessionId,
    timestamp: now,
    cwd: templateEntry.cwd,
    version: templateEntry.version,
    message: {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: [{ type: 'text', text: summaryText_ }]
      }]
    }
  };

  // Write subagent sidecar files: the topic's original entries become the
  // subagent's session, so Claude Code can drill in and see the full history.
  if (sessionFilePath) {
    try {
      const sessionId = templateEntry.sessionId;
      const subagentDir = path.join(path.dirname(sessionFilePath), sessionId, 'subagents');
      fs.mkdirSync(subagentDir, { recursive: true });

      // Copy topic entries verbatim, stamping each with agentId/promptId/isSidechain.
      // Reset the first entry's parentUuid to null (it's now a root in the subagent file).
      const topicEntries = history.filter(e => topicUuids.has(e.uuid));
      const agentEntries = topicEntries.map((e, i) => ({
        ...e,
        agentId,
        promptId,
        isSidechain: true,
        ...(i === 0 ? { parentUuid: null } : {})
      }));

      // Append a final assistant entry with the summary text
      const summaryEntry = {
        uuid: uuidv4(),
        parentUuid: agentEntries[agentEntries.length - 1]?.uuid ?? null,
        agentId,
        promptId,
        isSidechain: true,
        type: 'assistant',
        sessionId,
        timestamp: now,
        cwd: templateEntry.cwd,
        version: templateEntry.version,
        message: {
          model: 'claude-opus-4-6',
          role: 'assistant',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: summaryText_ }]
        }
      };

      const agentJsonl = [...agentEntries, summaryEntry].map(e => JSON.stringify(e)).join('\n') + '\n';
      fs.writeFileSync(path.join(subagentDir, `agent-${agentId}.jsonl`), agentJsonl);
      fs.writeFileSync(path.join(subagentDir, `agent-${agentId}.meta.json`), JSON.stringify({ agentType: 'summarizer' }));
    } catch (e) {
      Sidecar.log('SUBAGENT_WRITE_ERROR', { error: e.message });
    }
  }

  Sidecar.log('DORMANT_SUMMARY', { topic: topic.name, topicId: topic.id, assistantUuid, resultUuid, agentId });

  return [...history, assistantEntry, resultEntry];
}

/**
 * Find an existing dormant summary for a topic.
 * Returns { assistantEntry, resultEntry } or null.
 * The assistant entry has role='assistant' with a tool_use block.
 * The result entry has role='user' with a tool_result block containing the summary text.
 */
function findDormantSummary(history, topicId) {
  const matchesTopicId = (e) =>
    e.dormantSummaryFor === topicId ||
    (e.dormantSummaryFor && topicId && topicId.startsWith(e.dormantSummaryFor));

  const assistantEntry = history.find(e => matchesTopicId(e) && e.message?.role === 'assistant');
  if (!assistantEntry) return null;

  // Find the paired result entry (parented to the assistant entry)
  const resultEntry = history.find(e =>
    matchesTopicId(e) && e.message?.role === 'user' && e.parentUuid === assistantEntry.uuid
  );

  return { assistantEntry, resultEntry: resultEntry || null };
}

/**
 * Activate a dormant summary pair — link both entries into the chain in place
 * of the topic. The assistant entry is linked to the topic's grandparent,
 * the result entry to the assistant entry, and the downstream chain entry
 * is reparented to the result entry (or assistant entry if no result entry).
 */
function activateSummary(history, topic, dormantPair) {
  const { assistantEntry, resultEntry } = dormantPair;
  const topicUuids = new Set(topic.messages.map(m => m.uuid));
  const grandparentUuid = topic.messages[0].parentUuid;
  const lastMsgUuid = topic.messages[topic.messages.length - 1].uuid;
  // Downstream entries reparent to the tail of the summary pair
  const summaryTailUuid = resultEntry ? resultEntry.uuid : assistantEntry.uuid;

  Sidecar.log('ACTIVATE_SUMMARY', {
    topic: topic.name,
    topicId: topic.id,
    assistantUuid: assistantEntry.uuid,
    resultUuid: resultEntry?.uuid,
    reParentedTo: grandparentUuid
  });

  return history.map(entry => {
    // Activate the assistant entry: link it into the chain at grandparent
    if (entry.uuid === assistantEntry.uuid) {
      const { dormantSummaryFor, ...rest } = entry;
      return { ...rest, parentUuid: grandparentUuid };
    }
    // Activate the result entry: link it to the assistant entry (already set, just clear dormant flag)
    if (resultEntry && entry.uuid === resultEntry.uuid) {
      const { dormantSummaryFor, ...rest } = entry;
      return rest;
    }
    // Reparent the downstream entry from topic's last message to the summary tail
    if (entry.parentUuid === lastMsgUuid && !topicUuids.has(entry.uuid)) {
      return { ...entry, parentUuid: summaryTailUuid };
    }
    return entry;
  });
}

/**
 * Replace a topic's messages with a dormant summary pair.
 * If a dormant pair already exists, activates it. Otherwise creates one inline.
 */
function summarizeTopic(history, topic, summaryText, sessionFilePath) {
  // Check for an existing dormant summary
  const dormant = findDormantSummary(history, topic.id);
  if (dormant) {
    return activateSummary(history, topic, dormant);
  }

  // No dormant summary — create and activate immediately
  const withDormant = createDormantSummary(history, topic, summaryText, sessionFilePath);
  // Two entries were appended; assistant is second-to-last, result is last
  const resultEntry = withDormant[withDormant.length - 1];
  const assistantEntry = withDormant[withDormant.length - 2];
  return activateSummary(withDormant, topic, { assistantEntry, resultEntry });
}

// --- Safety gate: refuse writes if async work is in-flight ---

function guardInflight(entries) {
  // Only check the ACTIVE CHAIN for in-flight work. Orphaned entries from
  // previous prunes may contain stale tool_use blocks that never got a result
  // (because we removed them). Checking the whole file causes false positives.
  const activeUuids = getActiveChainUuids(entries);
  const activeEntries = entries.filter(e => activeUuids.has(e.uuid));

  const { pendingTools, activeSubagents, activeBackgroundTasks } = checkForInflightWork(activeEntries);
  const issues = [];

  // Exclude pending calls to our own MCP server — the runtime batches tool
  // results and may not have flushed earlier read-only calls by the time a
  // write call arrives. Match by prefix instead of a hardcoded set.
  const isOurTool = (name) => name?.startsWith('mcp__context-manager__');
  const externalPending = [...pendingTools].filter(id => {
    for (const entry of activeEntries) {
      if (!entry.message?.content) continue;
      for (const block of entry.message.content) {
        if (block.type === 'tool_use' && block.id === id) {
          return !isOurTool(block.name);
        }
      }
    }
    return true; // Unknown tool — treat as external
  });

  if (externalPending.length > 0) {
    issues.push(`${externalPending.length} other tool call(s) in-flight`);
  }
  if (activeSubagents > 0) {
    issues.push(`${activeSubagents} subagent(s) still running`);
  }
  if (activeBackgroundTasks > 0) {
    issues.push(`${activeBackgroundTasks} background task(s) still running`);
  }

  if (issues.length > 0) {
    return `Refusing to modify session file: ${issues.join(', ')}. ` +
           `Wait for all background work to complete before pruning.`;
  }
  return null;
}

/**
 * Find a topic by ID, supporting short prefix matching (min 8 chars).
 * Returns { topic } or { error } if not found or ambiguous.
 */
function findTopicById(topics, topicId) {
  if (!topicId) return { error: 'topic_id is required.' };
  // Exact match first
  const exact = topics.find(t => t.id === topicId);
  if (exact) return { topic: exact };
  // Prefix match (min 8 chars to avoid ambiguity)
  if (topicId.length < 8) return { error: `topic_id prefix too short (${topicId.length} chars). Provide at least 8 characters.` };
  const matches = topics.filter(t => t.id && t.id.startsWith(topicId));
  if (matches.length === 0) return { error: `Topic ID ${topicId} not found.` };
  if (matches.length > 1) return { error: `Ambiguous topic_id prefix "${topicId}" matches ${matches.length} topics. Provide a longer prefix.` };
  return { topic: matches[0] };
}

// --- API-powered summarization ---

/**
 * Extract readable text content from a topic's entries for summarization.
 */
function extractTopicContent(entries, topic) {
  const uuids = new Set(topic.messages.map(m => m.uuid));
  const parts = [];
  for (const entry of entries) {
    if (!uuids.has(entry.uuid) || !entry.message?.content) continue;
    const role = entry.message.role || entry.type;
    for (const block of entry.message.content) {
      if (block.type === 'text' && block.text) {
        parts.push(`[${role}] ${block.text.substring(0, 2000)}`);
      } else if (block.type === 'tool_use') {
        parts.push(`[tool_use: ${block.name}]`);
      } else if (block.type === 'tool_result') {
        const preview = typeof block.content === 'string'
          ? block.content.substring(0, 500)
          : JSON.stringify(block.content).substring(0, 500);
        parts.push(`[tool_result] ${preview}`);
      }
    }
  }
  return parts.join('\n\n');
}

/**
 * Call claude-opus-4-6 via the Anthropic API to generate a summary.
 * Returns the summary text, or null if ANTHROPIC_API_KEY is not set.
 */
async function generateSummaryWithAPI(topicContent, topicName, messageCount) {
  if (!process.env.ANTHROPIC_API_KEY) return null;

  const client = new Anthropic();
  const response = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 512,
    system: 'You are a session historian. Write concise summaries of conversation topics for context compression. Focus on decisions, outcomes, and final state. Skip debugging iterations and intermediate tool output. 2-4 sentences maximum.',
    messages: [{
      role: 'user',
      content: `Summarize this conversation topic "${topicName}" (${messageCount} messages) in 2-4 sentences. Focus on what was decided or changed, the final state of any files modified, and key outcomes.\n\n${topicContent}`
    }]
  });

  return response.content.find(b => b.type === 'text')?.text || null;
}

// --- Helper: wrap tool handler with error text response ---

function textResult(text) {
  return { content: [{ type: "text", text }] };
}

// --- Tool definitions ---

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "list_topics",
      description: "List all detected topics in the session history with their message counts and orphan status. Returns a summary for Claude to present to the user.",
      inputSchema: {
        type: "object",
        properties: { session_path: { type: "string", description: "Path to session .jsonl file. Auto-detected if omitted." } }
      }
    },
    {
      name: "bypass_topic",
      description: "Remove a topic from the active DAG chain by unlinking its messages and re-parenting downstream messages to the topic's grandparent. Provide the topic ID from list_topics.",
      inputSchema: {
        type: "object",
        properties: {
          topic_id: { type: "string", description: "Topic UUID from list_topics" },
          session_path: { type: "string" }
        },
        required: ["topic_id"]
      }
    },
    {
      name: "restore_topic",
      description: "Undo a bypass or summarize by re-inserting an orphaned topic back into the active chain. Only works on orphaned topics that were previously bypassed or summarized.",
      inputSchema: {
        type: "object",
        properties: {
          topic_id: { type: "string", description: "Topic UUID from list_topics" },
          session_path: { type: "string" }
        },
        required: ["topic_id"]
      }
    },
    {
      name: "branch_session",
      description: "Truncate session at target UUID and stage everything after it for later merge. Used for time-travel research.",
      inputSchema: {
        type: "object",
        properties: {
          target_uuid: { type: "string", description: "UUID to branch at" },
          session_path: { type: "string" }
        },
        required: ["target_uuid"]
      }
    },
    {
      name: "merge_future",
      description: "Re-append previously staged future messages back onto the active session.",
      inputSchema: {
        type: "object",
        properties: { session_path: { type: "string" } }
      }
    },
    {
      name: "get_topic_content",
      description: "Get the full text content of a topic's messages so Claude can generate a summary. Call this before summarize_topic.",
      inputSchema: {
        type: "object",
        properties: {
          topic_id: { type: "string", description: "Topic UUID from list_topics" },
          session_path: { type: "string" }
        },
        required: ["topic_id"]
      }
    },
    {
      name: "summarize_topic",
      description: "Replace a topic's messages with a subagent summary pair. If a dormant summary already exists (created by prepare_summary), it is activated instantly. Otherwise, claude-opus-4-6 is called automatically via the Anthropic API to generate the summary (requires ANTHROPIC_API_KEY). You may also pass a summary parameter to override auto-generation.",
      inputSchema: {
        type: "object",
        properties: {
          topic_id: { type: "string", description: "Topic UUID from list_topics" },
          summary: { type: "string", description: "The summary text. Optional if a dormant summary already exists." },
          session_path: { type: "string" }
        },
        required: ["topic_id"]
      }
    },
    {
      name: "prepare_summary",
      description: "Pre-generate a dormant summary for a topic using claude-opus-4-6 (requires ANTHROPIC_API_KEY). The summary is appended to the file but NOT linked into the active chain. When summarize_topic is later called for this topic, the dormant summary is activated instantly without another LLM call.",
      inputSchema: {
        type: "object",
        properties: {
          topic_id: { type: "string", description: "Topic UUID from list_topics" },
          summary: { type: "string", description: "Optional: override the auto-generated summary text" },
          session_path: { type: "string" }
        },
        required: ["topic_id"]
      }
    },
    {
      name: "get_context_stats",
      description: "Get current session statistics: message count, estimated token usage, active chain length, orphan count.",
      inputSchema: {
        type: "object",
        properties: { session_path: { type: "string" } }
      }
    },
    {
      name: "forget_prune",
      description: "Remove everything after a given message UUID from the active chain — used to erase the /prune interaction itself so the resumed session has no memory of pruning. Pass the UUID of the last message BEFORE the /prune interaction started. Call this as the very last step.",
      inputSchema: {
        type: "object",
        properties: {
          after_uuid: { type: "string", description: "UUID (or short prefix) of the last message to KEEP. Everything after this in the active chain will be removed." },
          session_path: { type: "string" }
        },
        required: ["after_uuid"]
      }
    },
    {
      name: "list_backups",
      description: "List available session backups (paginated, newest first). Backups are created automatically before every write operation and expire after 7 days.",
      inputSchema: {
        type: "object",
        properties: {
          session_path: { type: "string" },
          page: { type: "number", description: "Page number (1-indexed, default 1)" },
          page_size: { type: "number", description: "Backups per page (default 5)" }
        }
      }
    },
    {
      name: "restore_backup",
      description: "Restore the session file from a backup. Uses cp to write in-place (preserving inode). After restoring, orphaned entries appended by the runtime are reparented to the backup's tail.",
      inputSchema: {
        type: "object",
        properties: {
          backup_name: { type: "string", description: "Backup filename from list_backups" },
          session_path: { type: "string" }
        },
        required: ["backup_name"]
      }
    }
  ]
}));

// --- Tool handlers ---

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = request.params.arguments || {};
  const filePath = args.session_path || getAutoSessionPath();
  if (!filePath) {
    return textResult("Error: No session path. Provide session_path or ensure the stop hook has written .claude/session_path.txt.");
  }

  const pathErr = validateSessionPath(filePath);
  if (pathErr) return textResult(`Error: ${pathErr}`);

  const toolName = request.params.name;

  if (toolName === "list_topics") {
    const entries = readHistory(filePath);
    if (entries.length === 0) return textResult("Session file is empty or not found.");
    const topics = getTopics(entries);
    const scored = scorePruningCandidates(topics);

    // Build a map of summary↔original relationships.
    // New summaries embed (original: UUID). Legacy summaries only have the name.
    const summaryToOriginal = new Map(); // summary topic id → original topic id
    const originalToSummary = new Map(); // original topic id → summary topic id
    for (const t of scored) {
      const firstText = t.messages[0]?.text || '';
      if (!firstText.startsWith('[SUMMARY of')) continue;

      // Try to extract embedded original ID first (new format)
      const idMatch = firstText.match(/\(original: ([0-9a-f-]+)\)/);
      if (idMatch && t.id) {
        const originalId = idMatch[1];
        const original = scored.find(o => o.id && (o.id === originalId || o.id.startsWith(originalId)));
        if (original) {
          summaryToOriginal.set(t.id, original.id);
          originalToSummary.set(original.id, t.id);
          continue;
        }
      }

      // Fallback: match by name (legacy summaries without embedded ID)
      const nameMatch = firstText.match(/^\[SUMMARY of "(.+?)"/);
      if (nameMatch) {
        const originalName = nameMatch[1];
        // Only match if the name is unique AND both sides have real IDs
        const candidates = scored.filter(o => o.id && o.id !== t.id && o.name === originalName);
        if (candidates.length === 1 && t.id) {
          summaryToOriginal.set(t.id, candidates[0].id);
          originalToSummary.set(candidates[0].id, t.id);
        }
      }
    }

    // Build summary with size and tool info. Use short UUID prefix for display.
    // Also check for dormant summaries ready to activate.
    const shortId = (id) => typeof id === 'string' ? id.substring(0, 8) : String(id);
    const dormantMap = new Map(); // topic id → dormant entry uuid
    for (const entry of entries) {
      if (entry.dormantSummaryFor) {
        dormantMap.set(entry.dormantSummaryFor, entry.uuid);
      }
    }

    const lines = scored.map(t => {
      const flags = [];
      if (t.isOrphan) flags.push('ORPHAN');
      if (t.hasLargeToolResults) flags.push('HEAVY');
      if (t.toolUses > 5) flags.push(`${t.toolUses} tools`);
      // Show summary↔original links
      if (summaryToOriginal.has(t.id)) {
        flags.push(`SUMMARY, original: ${shortId(summaryToOriginal.get(t.id))}`);
      }
      if (originalToSummary.has(t.id)) {
        flags.push(`summarized as: ${shortId(originalToSummary.get(t.id))}`);
      }
      // Show dormant summary status
      if (t.id && dormantMap.has(t.id)) {
        flags.push('READY');
      }
      const flagStr = flags.length > 0 ? ` [${flags.join(', ')}]` : '';
      const tokens = t.estimatedTokens > 1000
        ? `~${Math.round(t.estimatedTokens / 1000)}k tok`
        : `~${t.estimatedTokens} tok`;
      const scoreStr = t.pruneScore > 0 ? ` (prune score: ${t.pruneScore})` : '';
      return `${shortId(t.id)}: ${t.name} (${t.messages.length} msgs, ${tokens})${flagStr}${scoreStr}`;
    });

    // Recommend top candidates (active topics with highest prune scores)
    const candidates = scored
      .filter(t => !t.isOrphan && t.pruneScore > 5)
      .sort((a, b) => b.pruneScore - a.pruneScore)
      .slice(0, 5);

    let recommendation = '';
    if (candidates.length > 0) {
      const totalSavings = candidates.reduce((sum, t) => sum + t.estimatedTokens, 0);
      recommendation = `\n\nRECOMMENDED TO BYPASS (tool-heavy, large, or iterative):\n` +
        candidates.map(t => {
          const tools = t.toolNames.length > 0 ? ` [${t.toolNames.slice(0, 4).join(', ')}]` : '';
          return `  ${shortId(t.id)}: ${t.name} (~${Math.round(t.estimatedTokens / 1000)}k tokens, score ${t.pruneScore})${tools}`;
        }).join('\n') +
        `\n  Estimated savings: ~${Math.round(totalSavings / 1000)}k tokens`;
    }

    const orphanCount = scored.filter(t => t.isOrphan).length;
    const activeCount = scored.filter(t => !t.isOrphan).length;

    return textResult(
      `${scored.length} topics (${activeCount} active, ${orphanCount} orphaned):\n\n` +
      lines.join('\n') +
      recommendation +
      `\n\nPresent the recommendations to the user using AskUserQuestion. Let them confirm or pick different IDs.`
    );
  }

  if (toolName === "bypass_topic") {
    const entries = readHistory(filePath);
    const inflightErr = guardInflight(entries);
    if (inflightErr) return textResult(inflightErr);
    const topics = getTopics(entries);
    const { topic, error: topicErr } = findTopicById(topics, args.topic_id);
    if (topicErr) return textResult(topicErr);

    const result = bypassTopic(entries, topic);
    const writeResult = safeWriteHistory(filePath, result);
    if (writeResult.error) return textResult(writeResult.error);
    return textResult(`Bypassed "${topic.name}" (${topic.messages.length} messages removed). Type /resume to reload with pruned history.`);
  }

  if (toolName === "restore_topic") {
    const entries = readHistory(filePath);
    const inflightErr = guardInflight(entries);
    if (inflightErr) return textResult(inflightErr);
    const topics = getTopics(entries);
    let { topic, error: topicErr } = findTopicById(topics, args.topic_id);
    if (topicErr) return textResult(topicErr);

    // If the user selected a summary topic (active, starts with '[SUMMARY of'),
    // find the original orphaned topic it replaced and restore that instead.
    const firstText = topic.messages[0]?.text || '';
    if (!topic.isOrphan && firstText.startsWith('[SUMMARY of')) {
      let original = null;

      // Try embedded original ID first (new format)
      const idMatch = firstText.match(/\(original: ([0-9a-f-]+)\)/);
      if (idMatch) {
        original = topics.find(t => t.isOrphan && (t.id === idMatch[1] || (t.id && t.id.startsWith(idMatch[1]))));
      }

      // Fallback: match by name (legacy summaries)
      if (!original) {
        const nameMatch = firstText.match(/^\[SUMMARY of "(.+?)"/);
        if (nameMatch) {
          const candidates = topics.filter(t => t.isOrphan && t.id !== topic.id && t.name === nameMatch[1]);
          if (candidates.length === 1) original = candidates[0];
        }
      }

      if (original) {
        topic = original;
      } else {
        return textResult(`Could not find the original topic that summary "${topic.name}" replaced. The original may have been deleted or the name is ambiguous.`);
      }
    }

    const result = restoreTopic(entries, topic);
    if (result.error) return textResult(result.error);
    const writeResult = safeWriteHistory(filePath, result);
    if (writeResult.error) return textResult(writeResult.error);
    return textResult(`Restored "${topic.name}". Type /resume to reload with updated history.`);
  }

  if (toolName === "branch_session") {
    const entries = readHistory(filePath);
    const inflightErr = guardInflight(entries);
    if (inflightErr) return textResult(inflightErr);
    const targetIdx = entries.findIndex(m => m.uuid === args.target_uuid);
    if (targetIdx === -1) return textResult("UUID not found in session.");

    const future = entries.slice(targetIdx + 1);
    const past = entries.slice(0, targetIdx + 1);

    // Write staged future first (no race concern — it's a new file)
    safeWriteHistory(STAGED_FUTURE_FILE, future);

    const writeResult = safeWriteHistory(filePath, past);
    if (writeResult.error) return textResult(writeResult.error);

    Sidecar.log('BRANCH', { target_uuid: args.target_uuid, stagedMessages: future.length });

    // Write reparent marker — the runtime will append the tool_result with a
    // parentUuid pointing to an entry we just moved to staging.
    const anchorUuid = past[past.length - 1].uuid;
    fs.writeFileSync(REPARENT_MARKER_FILE, JSON.stringify({ anchorUuid, sessionPath: filePath }));

    return textResult(`Branched at UUID. ${future.length} messages staged. Session now ends at the target message.`);
  }

  if (toolName === "merge_future") {
    if (!fs.existsSync(STAGED_FUTURE_FILE)) {
      return textResult("No staged future to merge.");
    }
    const active = readHistory(filePath);
    const inflightErr = guardInflight(active);
    if (inflightErr) return textResult(inflightErr);
    const staged = readHistory(STAGED_FUTURE_FILE);
    if (staged.length === 0) return textResult("Staged future file is empty.");

    // Re-parent the first staged message to the last active message
    staged[0] = { ...staged[0], parentUuid: active[active.length - 1].uuid };

    const writeResult = safeWriteHistory(filePath, active.concat(staged));
    if (writeResult.error) return textResult(writeResult.error);

    fs.unlinkSync(STAGED_FUTURE_FILE);
    Sidecar.log('MERGE', { mergedMessages: staged.length });
    return textResult(`Merged ${staged.length} staged messages back into session.`);
  }

  if (toolName === "get_context_stats") {
    const entries = readHistory(filePath);
    const activeUuids = getActiveChainUuids(entries);
    const orphanCount = entries.filter(e => !activeUuids.has(e.uuid)).length;

    // Only count message.content chars for active chain entries (not metadata, not orphans)
    let activeContentChars = 0;
    for (const entry of entries) {
      if (!activeUuids.has(entry.uuid)) continue;
      const stats = analyzeEntry(entry);
      activeContentChars += stats.contentChars;
    }
    const estimatedTokens = Math.round(activeContentChars / 4);

    return textResult(
      `Session stats:\n- Total messages: ${entries.length}\n- Active chain: ${activeUuids.size} messages\n` +
      `- Orphaned: ${orphanCount} messages\n- Active context tokens: ~${estimatedTokens.toLocaleString()}\n- Session file: ${filePath}`
    );
  }

  if (toolName === "get_topic_content") {
    const entries = readHistory(filePath);
    const topics = getTopics(entries);
    const { topic, error: topicErr } = findTopicById(topics, args.topic_id);
    if (topicErr) return textResult(topicErr);

    // Collect all text content from the topic's actual entries
    const uuids = new Set(topic.messages.map(m => m.uuid));
    const contentParts = [];
    for (const entry of entries) {
      if (!uuids.has(entry.uuid)) continue;
      if (!entry.message?.content) continue;
      const role = entry.message.role || entry.type;
      for (const block of entry.message.content) {
        if (block.type === 'text' && block.text) {
          contentParts.push(`[${role}] ${block.text.substring(0, 2000)}`);
        } else if (block.type === 'tool_use') {
          contentParts.push(`[tool_use: ${block.name}]`);
        } else if (block.type === 'tool_result') {
          const preview = typeof block.content === 'string'
            ? block.content.substring(0, 500)
            : JSON.stringify(block.content).substring(0, 500);
          contentParts.push(`[tool_result] ${preview}...`);
        }
      }
    }

    return textResult(
      `Topic "${topic.name}" (${topic.messages.length} messages, ~${topic.estimatedTokens || '?'} tokens):\n\n` +
      contentParts.join('\n\n') +
      `\n\nYou may now call summarize_topic with this topic_id — it will auto-generate a summary via claude-opus-4-6. Or pass a summary parameter to override.`
    );
  }

  if (toolName === "prepare_summary") {
    const entries = readHistory(filePath);
    const topics = getTopics(entries);
    const { topic, error: topicErr } = findTopicById(topics, args.topic_id);
    if (topicErr) return textResult(topicErr);

    // Check if a dormant summary already exists
    const existing = findDormantSummary(entries, topic.id);
    if (existing) {
      return textResult(`Dormant summary already exists for "${topic.name}" (${existing.assistantEntry.uuid.substring(0, 8)}).`);
    }

    // Use API to generate summary, or fall back to caller-provided text
    let summaryText = args.summary;
    if (!summaryText) {
      const content = extractTopicContent(entries, topic);
      const apiSummary = await generateSummaryWithAPI(content, topic.name, topic.messages.length);
      if (apiSummary) {
        summaryText = apiSummary;
      } else {
        return textResult(`No ANTHROPIC_API_KEY set and no summary provided. Either set ANTHROPIC_API_KEY or pass a summary parameter.`);
      }
    }

    const result = createDormantSummary(entries, topic, summaryText, filePath);
    const writeResult = safeWriteHistory(filePath, result);
    if (writeResult.error) return textResult(writeResult.error);
    return textResult(
      `Prepared dormant summary for "${topic.name}" (${topic.messages.length} msgs) using claude-opus-4-6. ` +
      `Call summarize_topic to activate it.`
    );
  }

  if (toolName === "summarize_topic") {
    const entries = readHistory(filePath);
    const inflightErr = guardInflight(entries);
    if (inflightErr) return textResult(inflightErr);
    const topics = getTopics(entries);
    const { topic, error: topicErr } = findTopicById(topics, args.topic_id);
    if (topicErr) return textResult(topicErr);

    // Check for existing dormant summary
    const dormant = findDormantSummary(entries, topic.id);
    if (dormant) {
      const result = activateSummary(entries, topic, dormant);
      const writeResult = safeWriteHistory(filePath, result);
      if (writeResult.error) return textResult(writeResult.error);
      return textResult(
        `Activated pre-built summary for "${topic.name}": replaced ${topic.messages.length} messages. ` +
        `Type /resume to reload with summarized history.`
      );
    }

    // No dormant summary — generate via API or use caller-provided text
    let summaryText = args.summary;
    if (!summaryText) {
      const content = extractTopicContent(entries, topic);
      const apiSummary = await generateSummaryWithAPI(content, topic.name, topic.messages.length);
      if (apiSummary) {
        summaryText = apiSummary;
      } else {
        return textResult(`No dormant summary exists for "${topic.name}". Set ANTHROPIC_API_KEY for auto-summarization, or provide a summary parameter.`);
      }
    }

    const result = summarizeTopic(entries, topic, summaryText, filePath);
    const writeResult = safeWriteHistory(filePath, result);
    if (writeResult.error) return textResult(writeResult.error);
    return textResult(
      `Summarized "${topic.name}": replaced ${topic.messages.length} messages with a subagent summary pair. ` +
      `Type /resume to reload with summarized history.`
    );
  }

  if (toolName === "forget_prune") {
    const entries = readHistory(filePath);
    const inflightErr = guardInflight(entries);
    if (inflightErr) return textResult(inflightErr);

    if (!args.after_uuid) return textResult("after_uuid is required.");

    // Find the anchor message (the last one to keep)
    if (args.after_uuid && args.after_uuid.length < 8) {
      return textResult(`after_uuid prefix too short (${args.after_uuid.length} chars). Provide at least 8 characters.`);
    }
    const uuidMap = buildUuidMap(entries);
    const matches = [...uuidMap.values()].filter(
      e => e.uuid && (e.uuid === args.after_uuid || e.uuid.startsWith(args.after_uuid))
    );
    if (matches.length === 0) return textResult(`UUID ${args.after_uuid} not found in session.`);
    if (matches.length > 1) return textResult(`Ambiguous UUID prefix "${args.after_uuid}" matches ${matches.length} entries.`);
    const anchor = matches[0];

    // Walk the active chain from the true tail back to the anchor, collecting everything after it
    const tail = findActiveTail(entries);
    const uuidsToRemove = new Set();
    let curr = tail;
    while (curr && curr.uuid !== anchor.uuid) {
      uuidsToRemove.add(curr.uuid);
      curr = curr.parentUuid ? uuidMap.get(curr.parentUuid) : null;
    }

    if (uuidsToRemove.size === 0) return textResult("Nothing to remove — anchor is already the tail.");

    Sidecar.log('FORGET_PRUNE', { removedCount: uuidsToRemove.size, anchorUuid: anchor.uuid });

    // Remove messages after the anchor. Re-parent any surviving message
    // whose parent was removed to point to the anchor instead.
    const result = entries
      .filter(e => !uuidsToRemove.has(e.uuid))
      .map(e => {
        if (e.parentUuid && uuidsToRemove.has(e.parentUuid)) {
          return { ...e, parentUuid: anchor.uuid };
        }
        return e;
      });

    const writeResult = safeWriteHistory(filePath, result);
    if (writeResult.error) return textResult(writeResult.error);

    // Write marker for the PostToolUse hook. After this tool returns,
    // the runtime appends the tool_result entry with a parentUuid pointing
    // to a removed message. The hook will reparent it to the anchor.
    fs.writeFileSync(REPARENT_MARKER_FILE, JSON.stringify({
      anchorUuid: anchor.uuid,
      sessionPath: filePath
    }));

    return textResult(
      `Removed ${uuidsToRemove.size} messages from the tail of the active chain. ` +
      `The pruning interaction will be erased after the post-tool hook reparents. Type /resume to reload.`
    );
  }

  if (toolName === "list_backups") {
    const backups = listBackups(filePath);
    if (backups.length === 0) return textResult("No backups found for this session.");

    const page = Math.max(1, args.page || 1);
    const pageSize = Math.max(1, Math.min(20, args.page_size || 5));
    const totalPages = Math.ceil(backups.length / pageSize);
    const start = (page - 1) * pageSize;
    const pageBackups = backups.slice(start, start + pageSize);

    if (pageBackups.length === 0) return textResult(`Page ${page} is empty. Total backups: ${backups.length}, total pages: ${totalPages}.`);

    const lines = pageBackups.map((b, i) => {
      const size = b.size > 1024 * 1024
        ? `${(b.size / 1024 / 1024).toFixed(1)}MB`
        : `${Math.round(b.size / 1024)}KB`;
      const age = Math.round((Date.now() - new Date(b.mtime).getTime()) / 60000);
      const ageStr = age < 60 ? `${age}m ago` : age < 1440 ? `${Math.round(age / 60)}h ago` : `${Math.round(age / 1440)}d ago`;
      return `${start + i + 1}. ${b.name} (${b.lines} entries, ${size}, ${ageStr})`;
    });

    return textResult(
      `Backups (page ${page}/${totalPages}, ${backups.length} total):\n\n${lines.join('\n')}` +
      (page < totalPages ? `\n\nCall list_backups with page=${page + 1} to see more.` : '') +
      `\n\nAsk the user which backup to restore.`
    );
  }

  if (toolName === "restore_backup") {
    if (!args.backup_name) return textResult("backup_name is required.");
    if (args.backup_name.includes('/') || args.backup_name.includes('\\') || args.backup_name.includes('..')) {
      return textResult("Invalid backup name — must not contain path separators or '..'.");
    }

    const backupPath = path.join(BACKUP_DIR, args.backup_name);
    if (!fs.existsSync(backupPath)) return textResult(`Backup not found: ${args.backup_name}`);

    // Read the backup to find its tail UUID (for reparenting)
    const backupEntries = readHistory(backupPath);
    if (backupEntries.length === 0) return textResult("Backup file is empty.");

    const backupUuids = new Set(backupEntries.filter(e => e.uuid).map(e => e.uuid));
    // Find the backup's active tail
    const backupParents = new Set(backupEntries.filter(e => e.parentUuid).map(e => e.parentUuid));
    let backupTail = null;
    for (let i = backupEntries.length - 1; i >= 0; i--) {
      if (backupEntries[i].uuid && !backupParents.has(backupEntries[i].uuid)) {
        backupTail = backupEntries[i];
        break;
      }
    }
    if (!backupTail) return textResult("Could not find active tail in backup.");

    // Copy backup over the session file in-place (preserves inode)
    fs.copyFileSync(backupPath, filePath);

    // Now read the file back — the runtime may have already appended entries
    // after our copyFileSync. Find orphans and reparent to backup tail.
    const currentEntries = readHistory(filePath);
    const currentUuids = new Set(currentEntries.filter(e => e.uuid).map(e => e.uuid));
    let reparented = 0;
    const result = currentEntries.map(e => {
      if (e.parentUuid && !currentUuids.has(e.parentUuid)) {
        reparented++;
        return { ...e, parentUuid: backupTail.uuid };
      }
      return e;
    });

    if (reparented > 0) {
      fs.writeFileSync(filePath, result.map(e => JSON.stringify(e)).join('\n') + '\n');
    }

    Sidecar.log('RESTORE_BACKUP', { backup: args.backup_name, backupTail: backupTail.uuid, reparented });
    return textResult(
      `Restored from "${args.backup_name}" (${backupEntries.length} entries). ` +
      (reparented > 0 ? `Reparented ${reparented} orphaned entries. ` : '') +
      `Type /resume to reload.`
    );
  }

  return textResult(`Unknown tool: ${toolName}`);
});

// --- Exports for testing ---
if (typeof module !== 'undefined') {
  module.exports = {
    buildUuidMap, findActiveTail, getActiveChainUuids, getTextContent,
    analyzeEntry, getTopics, scorePruningCandidates, checkForInflightWork,
    bypassTopic, restoreTopic, createDormantSummary, findDormantSummary,
    activateSummary, summarizeTopic, findTopicById, validateSessionPath,
    guardInflight, readHistory, safeWriteHistory, extractTopicContent
  };
}

// Start server only when run directly (not when required by tests)
if (require.main === module) {
  async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
  }
  main().catch(console.error);
}
