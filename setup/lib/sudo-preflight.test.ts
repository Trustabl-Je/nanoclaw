import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  platform: 'linux' as 'linux' | 'macos',
  root: false,
  hasSudo: true,
  /** Exit code of `sudo -n true`. */
  cached: 1,
  /** Exit code of the foreground `sudo -v`. */
  validate: 0,
  hasDocker: true,
  /** Exit code of `docker info`. */
  dockerInfo: 0,
  spawnSync: vi.fn(),
  runInheritScript: vi.fn(),
}));
vi.mock('child_process', async (original) => ({
  ...(await original<typeof import('child_process')>()),
  spawnSync: fixture.spawnSync,
}));
vi.mock('../platform.js', () => ({
  getPlatform: () => fixture.platform,
  isRoot: () => fixture.root,
  commandExists: (name: string) => (name === 'docker' ? fixture.hasDocker : name === 'sudo' && fixture.hasSudo),
}));
vi.mock('./inherit-script.js', () => ({ runInheritScript: fixture.runInheritScript }));

import { SUDO_PROMPT, dockerSudoReason, sudoUpFront } from './sudo-preflight.js';

const stdinTTY = process.stdin.isTTY;
beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(fixture, {
    platform: 'linux',
    root: false,
    hasSudo: true,
    cached: 1,
    validate: 0,
    hasDocker: true,
    dockerInfo: 0,
  });
  fixture.spawnSync.mockImplementation((cmd: string) => ({
    status: cmd === 'docker' ? fixture.dockerInfo : fixture.cached,
  }));
  fixture.runInheritScript.mockImplementation(async () => fixture.validate);
  process.stdin.isTTY = true;
});
afterEach(() => {
  process.stdin.isTTY = stdinTTY;
});

describe('sudoUpFront', () => {
  it('explains, then asks for the password in the foreground', async () => {
    const explain = vi.fn();
    expect(await sudoUpFront(explain)).toBe('granted');
    expect(fixture.spawnSync).toHaveBeenCalledWith('sudo', ['-n', 'true'], { stdio: 'ignore' });
    expect(explain).toHaveBeenCalledOnce();
    expect(fixture.runInheritScript).toHaveBeenCalledWith('sudo', ['-v', '-p', SUDO_PROMPT]);
    expect(explain.mock.invocationCallOrder[0]).toBeLessThan(fixture.runInheritScript.mock.invocationCallOrder[0]);
  });

  it('reports a refused password', async () => {
    fixture.validate = 1;
    expect(await sudoUpFront(vi.fn())).toBe('refused');
  });

  it('stays quiet when sudo needs no password', async () => {
    fixture.cached = 0;
    const explain = vi.fn();
    expect(await sudoUpFront(explain)).toBe('not-needed');
    expect(explain).not.toHaveBeenCalled();
    expect(fixture.runInheritScript).not.toHaveBeenCalled();
  });

  it.each([
    ['root', () => (fixture.root = true)],
    ['macOS', () => (fixture.platform = 'macos')],
    ['no sudo installed', () => (fixture.hasSudo = false)],
    ['no terminal', () => (process.stdin.isTTY = false)],
  ])('never touches sudo for %s', async (_name, arrange) => {
    arrange();
    const explain = vi.fn();
    expect(await sudoUpFront(explain)).toBe('not-needed');
    expect(fixture.spawnSync).not.toHaveBeenCalled();
    expect(fixture.runInheritScript).not.toHaveBeenCalled();
    expect(explain).not.toHaveBeenCalled();
  });
});

describe('dockerSudoReason', () => {
  it('is install when Docker is missing', () => {
    fixture.hasDocker = false;
    expect(dockerSudoReason()).toBe('install');
    expect(fixture.spawnSync).not.toHaveBeenCalled();
  });

  // The container step runs `sudo systemctl start docker` (and `usermod` when
  // needed) whenever `docker info` fails, not only on a fresh install.
  it('is start when Docker is installed but not reachable', () => {
    fixture.dockerInfo = 1;
    expect(dockerSudoReason()).toBe('start');
    expect(fixture.spawnSync).toHaveBeenCalledWith('docker', ['info'], expect.objectContaining({ stdio: 'ignore' }));
  });

  it('leaves a probe that timed out to the step, as before', () => {
    fixture.spawnSync.mockImplementation(() => ({ status: null, error: new Error('spawnSync docker ETIMEDOUT') }));
    expect(dockerSudoReason()).toBeUndefined();
  });

  it('is nothing when Docker answers', () => {
    expect(dockerSudoReason()).toBeUndefined();
  });

  it.each([
    ['root', () => (fixture.root = true)],
    ['macOS', () => (fixture.platform = 'macos')],
  ])('is nothing for %s, without probing Docker', (_name, arrange) => {
    arrange();
    fixture.hasDocker = false;
    expect(dockerSudoReason()).toBeUndefined();
    expect(fixture.spawnSync).not.toHaveBeenCalled();
  });
});
