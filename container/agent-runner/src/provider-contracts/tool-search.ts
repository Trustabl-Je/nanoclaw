/**
 * Tool search as a provider capability: whether the harness a provider drives finds MCP tools by searching them
 * instead of loading every schema into the prompt, and the one switch that turns it on or off.
 */

export type ToolSearchCapability = { mode: 'native'; switch?: { env: string } } | { mode: 'none' };

export interface ToolSearchUse {
  query: string;
}

export const DEFAULT_MAX_TOOLS = 64;

const modeOf = (capability: ToolSearchCapability | undefined): ToolSearchCapability['mode'] =>
  capability?.mode ?? 'none';

/** The one line logged at session start: the provider's declared mode, its switch's value, the attached servers. */
export function describeToolSearch(
  provider: string,
  capability: ToolSearchCapability | undefined,
  serverNames: readonly string[],
  environment: NodeJS.ProcessEnv,
): string {
  const switchName = capability?.mode === 'native' ? capability.switch?.env : undefined;
  const state = switchName ? ` (${switchName}=${environment[switchName] || 'default'})` : '';
  return `tool search: ${provider} ${modeOf(capability)}${state}, servers: ${serverNames.join(', ')}`;
}

export interface ToolSearchVerdict {
  warning: string | null;
  refuse: boolean;
}

/**
 * A provider with no tool search and many tools puts every schema in the prompt. `toolCount` is what the servers'
 * tools/list gave, where the runner has it; without it the servers attached are the measure (more than one).
 */
export function checkToolSearch(
  capability: ToolSearchCapability | undefined,
  serverNames: readonly string[],
  environment: NodeJS.ProcessEnv,
  toolCount?: number,
): ToolSearchVerdict {
  if (modeOf(capability) !== 'none') return { warning: null, refuse: false };
  const limit = Number(environment.NANOCLAW_TOOL_SEARCH_MAX_TOOLS) || DEFAULT_MAX_TOOLS;
  const many = toolCount === undefined ? serverNames.length > 1 : toolCount > limit;
  if (!many) return { warning: null, refuse: false };
  const measure =
    toolCount === undefined ? `${serverNames.length} MCP servers` : `${toolCount} MCP tools (limit ${limit})`;
  return {
    warning: `provider has no tool search and ${measure} are attached: every tool schema goes in the prompt`,
    refuse: environment.NANOCLAW_TOOL_SEARCH_STRICT === '1',
  };
}

/** Session start: log the state, warn on the guard, and refuse to start when it is strict. */
export function announceToolSearch(
  provider: string,
  capability: ToolSearchCapability | undefined,
  serverNames: readonly string[],
  environment: NodeJS.ProcessEnv,
  log: (message: string) => void,
  toolCount?: number,
): void {
  log(describeToolSearch(provider, capability, serverNames, environment));
  const verdict = checkToolSearch(capability, serverNames, environment, toolCount);
  if (verdict.warning) log(`WARNING ${verdict.warning}`);
  if (verdict.refuse) throw new Error(`NANOCLAW_TOOL_SEARCH_STRICT: ${verdict.warning}`);
}
