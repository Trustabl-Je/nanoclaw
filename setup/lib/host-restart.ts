/**
 * Reload the running host after setup changed code it loads.
 *
 * The service runs the compiled `dist/` and reads `.env` only at start, so a
 * payload that adds host code stays invisible until the host is rebuilt and
 * restarted. `restart.sh` restarts whichever service this install uses
 * (launchd, systemd or the nohup wrapper) and waits for the new instance.
 *
 * The result is returned, never printed: the caller decides how loud a
 * failure is.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

/** What an operator runs by hand when the automatic reload fails. */
export const HOST_RESTART_COMMAND = 'pnpm run build && bash setup/lib/restart.sh';
/** The same without the build, for a restart that only reloads `.env`. */
export const HOST_RESTART_ONLY_COMMAND = 'bash setup/lib/restart.sh';

/** `no-service`: nothing runs this checkout's host, so there is nothing to reload. */
export type HostRestartResult =
  | { status: 'restarted'; buildFailed?: string }
  | { status: 'no-service'; buildFailed?: string }
  | { status: 'failed'; message: string };

/** The `.env` text the host reads at start; compare two reads to see whether a restart is due. */
export function readHostSettings(projectRoot: string = process.cwd()): string {
  try {
    return fs.readFileSync(path.join(projectRoot, '.env'), 'utf8');
  } catch {
    return '';
  }
}

/**
 * Rebuild the host and restart its service. Synchronous with inherited output.
 * `build: 'try'` is for a settings change: it still builds (an earlier run may
 * have stopped before compiling), but restarts the existing build if that
 * fails, reporting it as `buildFailed`, since the new settings only need a
 * restart.
 */
export function restartHost(
  projectRoot: string = process.cwd(),
  opts: { build?: boolean | 'try' } = {},
): HostRestartResult {
  const run = (command: string, args: string[]): { code: number | null; problem?: string } => {
    const res = spawnSync(command, args, { cwd: projectRoot, stdio: ['ignore', 'inherit', 'inherit'] });
    const step = `${command} ${args.join(' ')}`;
    if (res.error) return { code: null, problem: `couldn't run ${step}: ${res.error.message}` };
    if (res.signal) return { code: null, problem: `${step} was terminated by ${res.signal}` };
    return { code: res.status, problem: res.status === 0 ? undefined : `${step} exited ${res.status}` };
  };
  let buildFailed: string | undefined;
  if (opts.build !== false) {
    const build = run('pnpm', ['run', 'build']);
    if (build.problem && opts.build !== 'try') return { status: 'failed', message: build.problem };
    buildFailed = build.problem;
  }
  const restart = run('bash', ['setup/lib/restart.sh']);
  if (restart.code === 2) return buildFailed ? { status: 'no-service', buildFailed } : { status: 'no-service' };
  if (restart.problem) return { status: 'failed', message: restart.problem };
  return buildFailed ? { status: 'restarted', buildFailed } : { status: 'restarted' };
}
