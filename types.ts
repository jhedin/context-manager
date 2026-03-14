// types.ts
import type { ToolInputSchemas, ToolOutputSchemas } from '@anthropic-ai/claude-code/sdk-tools';

/**
 * Our bridge interface for the Claude Code .jsonl schema.
 * This composes the official Tool types with the session DAG metadata.
 */
export interface ClaudeSessionEntry {
  uuid: string;
  parentUuid: string | null;
  sessionId: string;
  timestamp: string;
  type: 'user' | 'assistant' | 'progress' | 'system' | 'thought';
  message?: {
    role: 'user' | 'assistant';
    content: Array<ClaudeContent>;
    model?: string;
    usage?: ClaudeUsage;
  };
}

export type ClaudeContent = 
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: ToolInputSchemas }
  | { type: 'tool_result'; tool_use_id: string; content: string | ToolOutputSchemas; is_error?: boolean };

export interface ClaudeUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}
