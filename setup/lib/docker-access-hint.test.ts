import { describe, expect, it } from 'vitest';

import { dockerAccessHint } from './docker-access-hint.js';

const unit = 'nanoclaw-v2-0123abcd';
const linux = { wsl: false, apt: true };

describe('dockerAccessHint', () => {
  it('says nothing when the service reaches Docker', () => {
    expect(dockerAccessHint({ STATUS: 'success' }, unit, linux)).toBeNull();
  });

  it('installs acl first when setfacl is missing', () => {
    const hint = dockerAccessHint({ DOCKER_GROUP_STALE: 'true', SETFACL_MISSING: 'true' }, unit, linux);
    expect(hint?.commands).toEqual([
      'sudo apt-get install -y acl',
      'sudo setfacl -m u:$(whoami):rw /var/run/docker.sock',
      `systemctl --user restart ${unit}`,
    ]);
  });

  it('skips the acl install when setfacl is already there', () => {
    const hint = dockerAccessHint({ DOCKER_GROUP_STALE: 'true' }, unit, linux);
    expect(hint?.commands).toEqual([
      'sudo setfacl -m u:$(whoami):rw /var/run/docker.sock',
      `systemctl --user restart ${unit}`,
    ]);
  });

  it('does not print an apt-get line on systems without apt', () => {
    const hint = dockerAccessHint({ DOCKER_GROUP_STALE: 'true', SETFACL_MISSING: 'true' }, unit, {
      wsl: false,
      apt: false,
    });
    expect(hint?.commands.join('\n')).not.toContain('apt-get');
    expect(hint?.commands[0]).toMatch(/acl package/);
  });

  it('names a reboot as the lasting fix, or wsl --shutdown on WSL, and never a re-login', () => {
    const plain = dockerAccessHint({ DOCKER_GROUP_STALE: 'true' }, unit, linux)!;
    const wsl = dockerAccessHint({ DOCKER_GROUP_STALE: 'true' }, unit, { wsl: true, apt: true })!;
    expect(plain.note).toMatch(/reboot/i);
    expect(wsl.note).toContain('wsl --shutdown');
    expect(wsl.note).toMatch(/PowerShell/);
    for (const note of [plain.note, wsl.note]) expect(note).not.toMatch(/log (out|in)/i);
  });
});
