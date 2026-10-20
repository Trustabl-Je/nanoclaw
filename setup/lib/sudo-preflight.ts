import { spawnSync } from 'child_process';

import { commandExists, getPlatform, isRoot } from '../platform.js';
import { runInheritScript } from './inherit-script.js';

/** sudo's prompt, indented to line up with the wizard's log lines. */
export const SUDO_PROMPT = '   [sudo] password for %p: ';

export type SudoUpFront = 'not-needed' | 'granted' | 'refused';

/**
 * Why the container step will call sudo here, if it will. Besides installing
 * a missing Docker, on Linux it runs `sudo systemctl start docker` (and
 * `usermod` when needed) whenever `docker info` fails.
 */
export function dockerSudoReason(): 'install' | 'start' | undefined {
  if (getPlatform() !== 'linux' || isRoot()) return undefined;
  if (!commandExists('docker')) return 'install';
  const info = spawnSync('docker', ['info'], { stdio: 'ignore', timeout: 15_000 });
  // A probe that timed out proves nothing; leave it to the step, as before.
  return info.status === 0 || info.status === null ? undefined : 'start';
}

/**
 * Put sudo's password prompt in front of the user before a step that needs
 * it. Steps run with stdin ignored and their output in a window, so a prompt
 * from inside one is hidden and times out. A `sudo -v` here refreshes the
 * timestamp that the step's own sudo calls then reuse.
 */
export async function sudoUpFront(explain: () => void): Promise<SudoUpFront> {
  if (getPlatform() !== 'linux' || isRoot()) return 'not-needed';
  // Without a terminal nobody can answer, so keep the old behaviour.
  if (!process.stdin.isTTY || !commandExists('sudo')) return 'not-needed';
  if (spawnSync('sudo', ['-n', 'true'], { stdio: 'ignore' }).status === 0) return 'not-needed';
  explain();
  return (await runInheritScript('sudo', ['-v', '-p', SUDO_PROMPT])) === 0 ? 'granted' : 'refused';
}
