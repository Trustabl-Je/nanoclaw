/**
 * Claude's tool search, read back from the Agent SDK's on-disk transcript: the ToolSearch tool uses the model made, whole
 * session and last turn. `recordClaudeToolSearch` logs the turn's and writes the session's in a folder named for the
 * transcript, beside it.
 */

import fs from 'fs';
import path from 'path';

import type { RuntimeAfterExchangeInput, RuntimeCallbackEffects } from '../provider-contracts/registry.js';
import type { ToolSearchCapability, ToolSearchUse } from '../provider-contracts/tool-search.js';
import { claudeConfigDirectory, newestClaudeTranscript } from './claude-history.js';

export const CLAUDE_TOOL_SEARCH: ToolSearchCapability = { mode: 'native', switch: { env: 'ENABLE_TOOL_SEARCH' } };

const SEARCH_TOOLS = new Set(['ToolSearch', 'tool_search_tool_regex', 'tool_search_tool_bm25']);
const QUERY_LOG_CHARS = 80;

interface Scan {
  session: ToolSearchUse[];
  turn: ToolSearchUse[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** A user entry that starts a turn: text from the person, not a tool result and not the harness's own note. */
function startsTurn(entry: Record<string, unknown>): boolean {
  if (entry.type !== 'user' || entry.isMeta === true || !isRecord(entry.message)) return false;
  const { content } = entry.message;
  if (typeof content === 'string') return true;
  return Array.isArray(content) && content.some((block) => isRecord(block) && block.type === 'text');
}

function searchesIn(entry: Record<string, unknown>): ToolSearchUse[] {
  if (entry.type !== 'assistant' || !isRecord(entry.message) || !Array.isArray(entry.message.content)) return [];
  return entry.message.content.flatMap((block): ToolSearchUse[] => {
    if (!isRecord(block) || (block.type !== 'tool_use' && block.type !== 'server_tool_use')) return [];
    if (typeof block.name !== 'string' || !SEARCH_TOOLS.has(block.name)) return [];
    const input = isRecord(block.input) ? block.input : {};
    const query = input.query ?? input.regex;
    return [{ query: typeof query === 'string' ? query : '' }];
  });
}

export function scanClaudeToolSearch(transcript: string): Scan {
  const scan: Scan = { session: [], turn: [] };
  for (const line of transcript.split('\n')) {
    if (!line.trim()) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(entry)) continue;
    if (startsTurn(entry)) scan.turn = [];
    const uses = searchesIn(entry);
    scan.session.push(...uses);
    scan.turn.push(...uses);
  }
  return scan;
}

/** `history.toolSearchUses`: every search the model made in the transcript at `trace`. */
export function readClaudeToolSearchUses(trace: string): ToolSearchUse[] {
  try {
    return scanClaudeToolSearch(fs.readFileSync(trace, 'utf-8')).session;
  } catch {
    return [];
  }
}

function transcriptFor(continuation: string | undefined): string | null {
  if (continuation) {
    const projects = path.join(claudeConfigDirectory(), 'projects');
    try {
      for (const dir of fs.readdirSync(projects)) {
        const candidate = path.join(projects, dir, `${continuation}.jsonl`);
        if (fs.existsSync(candidate)) return candidate;
      }
    } catch {
      // No projects directory yet: the newest transcript, if any, is the best there is.
    }
  }
  return newestClaudeTranscript();
}

const clipped = (query: string): string =>
  query.length > QUERY_LOG_CHARS ? `${query.slice(0, QUERY_LOG_CHARS)}…` : query;

/** `history.afterExchange`: log the turn's searches and write the session's as `<session>/tool-search.json`. */
export function recordClaudeToolSearch(
  input: RuntimeAfterExchangeInput,
  _fx: RuntimeCallbackEffects,
  log: (message: string) => void = (message) => console.error(`[agent-runner] ${message}`),
): string | null {
  try {
    const trace = transcriptFor(input.exchange.continuation);
    if (!trace) return null;
    const { session, turn } = scanClaudeToolSearch(fs.readFileSync(trace, 'utf-8'));
    log(`tool search uses this turn: ${turn.length} (${turn.map((use) => clipped(use.query)).join(', ')})`);
    const folder = trace.replace(/\.jsonl$/, '');
    fs.mkdirSync(folder, { recursive: true });
    const target = path.join(folder, 'tool-search.json');
    fs.writeFileSync(
      target,
      JSON.stringify({ uses: session, provider: 'claude', mode: CLAUDE_TOOL_SEARCH.mode }, null, 2) + '\n',
    );
    return target;
  } catch (error) {
    log(`tool search record failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
