/**
 * One-time backfill: seed `container_configs` rows from existing
 * `groups/<folder>/container.json` files and `agent_groups.agent_provider`.
 *
 * Runs after migrations, before channel adapters start. Idempotent — skips
 * groups that already have a config row.
 */
import path from 'path';

import { AnchoredDir } from './anchored-dir.js';
import { GROUPS_DIR } from './config.js';
import type { McpServerConfig, AdditionalMountConfig } from './container-config.js';
import { getAllAgentGroups } from './db/agent-groups.js';
import { getContainerConfig, createContainerConfig } from './db/container-configs.js';
import { log } from './log.js';
import type { ContainerConfigRow } from './types.js';

interface LegacyContainerJson {
  mcpServers?: Record<string, McpServerConfig>;
  packages?: { apt?: string[]; npm?: string[] };
  imageTag?: string;
  additionalMounts?: AdditionalMountConfig[];
  skills?: string[] | 'all';
  provider?: string;
  assistantName?: string;
  maxMessagesPerPrompt?: number;
}

export async function backfillContainerConfigs(): Promise<void> {
  const groups = await getAllAgentGroups();
  let backfilled = 0;

  for (const group of groups) {
    // Skip if already has a config row
    if (await getContainerConfig(group.id)) continue;

    const legacy = readLegacyContainerJson(group.folder);

    // DB agent_provider wins over file provider (matches old cascade)
    const provider = group.agent_provider || legacy.provider || null;

    const row: ContainerConfigRow = {
      agent_group_id: group.id,
      provider,
      model: null,
      effort: null,
      image_tag: legacy.imageTag ?? null,
      assistant_name: legacy.assistantName ?? null,
      max_messages_per_prompt: legacy.maxMessagesPerPrompt ?? null,
      skills: JSON.stringify(legacy.skills ?? 'all'),
      mcp_servers: JSON.stringify(legacy.mcpServers ?? {}),
      packages_apt: JSON.stringify(legacy.packages?.apt ?? []),
      packages_npm: JSON.stringify(legacy.packages?.npm ?? []),
      additional_mounts: JSON.stringify(legacy.additionalMounts ?? []),
      cli_scope: 'group',
      timezone: null,
      speed: null,
      updated_at: new Date().toISOString(),
    };

    await createContainerConfig(row);
    backfilled++;
  }

  if (backfilled > 0) {
    log.info('Backfilled container_configs from disk', { count: backfilled });
  }
}

/**
 * The group folder is mounted read-write into the agent container, so
 * `container.json` is read through the folder's descriptor: a symlink or
 * any non-regular file under that name is skipped, never followed.
 */
function readLegacyContainerJson(folder: string): LegacyContainerJson {
  let raw: string;
  let dir: AnchoredDir | null = null;
  try {
    dir = AnchoredDir.open(path.join(GROUPS_DIR, folder), []);
    if (!dir) return {};
    raw = dir.readFile('container.json').toString('utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    log.warn('Backfill: legacy container.json not read (not a regular file, or unreadable), using defaults', {
      folder,
      code: (err as NodeJS.ErrnoException).code,
    });
    return {};
  } finally {
    dir?.close();
  }
  // The parse error quotes the input, so only a generic reason is logged.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    log.warn('Backfill: legacy container.json is not a JSON object, using defaults', { folder });
    return {};
  }
  return parsed as LegacyContainerJson;
}
