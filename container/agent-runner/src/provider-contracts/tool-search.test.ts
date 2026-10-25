import { describe, expect, it } from 'bun:test';

import { announceToolSearch, checkToolSearch, describeToolSearch } from './tool-search.js';

const native = { mode: 'native', switch: { env: 'ENABLE_TOOL_SEARCH' } } as const;
const none = { mode: 'none' } as const;

describe('tool search line', () => {
  it('names the provider, its mode, the switch value and the servers', () => {
    expect(describeToolSearch('claude', native, ['nanoclaw', 'np'], { ENABLE_TOOL_SEARCH: 'auto:5' })).toBe(
      'tool search: claude native (ENABLE_TOOL_SEARCH=auto:5), servers: nanoclaw, np',
    );
  });

  it('says default for an unset switch and omits the switch for none', () => {
    expect(describeToolSearch('claude', native, ['np'], {})).toBe(
      'tool search: claude native (ENABLE_TOOL_SEARCH=default), servers: np',
    );
    expect(describeToolSearch('mock', none, ['np'], {})).toBe('tool search: mock none, servers: np');
    expect(describeToolSearch('legacy', undefined, [], {})).toBe('tool search: legacy none, servers: ');
  });
});

describe('tool search guard', () => {
  it('never fires for a provider that searches', () => {
    expect(checkToolSearch(native, ['a', 'b', 'c'], {}, 500)).toEqual({ warning: null, refuse: false });
  });

  it('counts servers when no tool count is known', () => {
    expect(checkToolSearch(none, ['nanoclaw'], {}).warning).toBeNull();
    expect(checkToolSearch(none, ['nanoclaw', 'np'], {}).warning).toContain('2 MCP servers');
  });

  it('counts tools against the limit when it has them', () => {
    expect(checkToolSearch(none, ['a', 'b'], {}, 64).warning).toBeNull();
    expect(checkToolSearch(none, ['a'], {}, 65).warning).toContain('65 MCP tools (limit 64)');
    expect(checkToolSearch(none, ['a'], { NANOCLAW_TOOL_SEARCH_MAX_TOOLS: '10' }, 11).warning).toContain('limit 10');
  });

  it('refuses only when strict', () => {
    expect(checkToolSearch(none, ['a', 'b'], {}).refuse).toBe(false);
    expect(checkToolSearch(none, ['a', 'b'], { NANOCLAW_TOOL_SEARCH_STRICT: '1' }).refuse).toBe(true);
  });
});

describe('announceToolSearch', () => {
  it('logs the line, then the warning', () => {
    const lines: string[] = [];
    announceToolSearch('mock', none, ['nanoclaw', 'np'], {}, (m) => lines.push(m));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toStartWith('tool search: mock none');
    expect(lines[1]).toStartWith('WARNING provider has no tool search');
  });

  it('throws when strict and over the limit', () => {
    expect(() =>
      announceToolSearch('mock', none, ['nanoclaw', 'np'], { NANOCLAW_TOOL_SEARCH_STRICT: '1' }, () => {}),
    ).toThrow(/NANOCLAW_TOOL_SEARCH_STRICT/);
  });

  it('logs one line for a provider that searches', () => {
    const lines: string[] = [];
    announceToolSearch('claude', native, ['nanoclaw', 'np'], {}, (m) => lines.push(m));
    expect(lines).toEqual(['tool search: claude native (ENABLE_TOOL_SEARCH=default), servers: nanoclaw, np']);
  });
});
