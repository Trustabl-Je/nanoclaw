import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { readClaudeToolSearchUses, recordClaudeToolSearch, scanClaudeToolSearch } from './claude-tool-search.js';

const line = (value: unknown) => JSON.stringify(value);
const person = (text: string) => line({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
const toolResult = line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } });
const search = (query: string, name = 'ToolSearch') =>
  line({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input: { query } }] } });
const call = line({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', name: 'mcp__example__x', input: {} }] },
});

const TRANSCRIPT = [
  person('first'),
  search('select:github_get_repo'),
  toolResult,
  call,
  person('second'),
  search('github pull requests'),
  toolResult,
  line({
    type: 'assistant',
    message: { content: [{ type: 'server_tool_use', name: 'tool_search_tool_regex', input: { regex: 'notion_.*' } }] },
  }),
  'not json',
  line({ type: 'user', isMeta: true, message: { content: 'harness note' } }),
].join('\n');

describe('reading ToolSearch uses', () => {
  it('lists every search of the session and the last turn alone', () => {
    const scan = scanClaudeToolSearch(TRANSCRIPT);
    expect(scan.session.map((use) => use.query)).toEqual([
      'select:github_get_repo',
      'github pull requests',
      'notion_.*',
    ]);
    expect(scan.turn.map((use) => use.query)).toEqual(['github pull requests', 'notion_.*']);
  });

  it('ignores other tools and a transcript with no search', () => {
    expect(scanClaudeToolSearch([person('hi'), call].join('\n'))).toEqual({ session: [], turn: [] });
  });
});

describe('recording a turn', () => {
  let home: string;
  let saved: string | undefined;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-search-'));
    saved = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = home;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('logs the turn and writes the session in a folder beside its transcript', () => {
    const dir = path.join(home, 'projects', '-workspace-agent');
    fs.mkdirSync(dir, { recursive: true });
    const trace = path.join(dir, 'ses-1.jsonl');
    fs.writeFileSync(trace, TRANSCRIPT);
    const lines: string[] = [];
    const written = recordClaudeToolSearch(
      { exchange: { prompt: 'second', result: 'done', continuation: 'ses-1', status: 'completed' } },
      { now: () => 0 },
      (message) => lines.push(message),
    );
    expect(lines).toEqual(['tool search uses this turn: 2 (github pull requests, notion_.*)']);
    expect(written).toBe(path.join(dir, 'ses-1', 'tool-search.json'));
    expect(JSON.parse(fs.readFileSync(written!, 'utf-8'))).toEqual({
      uses: [{ query: 'select:github_get_repo' }, { query: 'github pull requests' }, { query: 'notion_.*' }],
      provider: 'claude',
      mode: 'native',
    });
    expect(readClaudeToolSearchUses(trace)).toHaveLength(3);
  });

  it('reads an unreadable trace as no uses', () => {
    expect(readClaudeToolSearchUses(path.join(home, 'missing.jsonl'))).toEqual([]);
  });
});
