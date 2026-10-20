import { commandExists, isWSL } from '../platform.js';

/**
 * What to tell the user when the service step could not let the background
 * service reach Docker (DOCKER_GROUP_STALE in SETUP_SERVICE). Returns null
 * when there is nothing to fix.
 */
export function dockerAccessHint(
  fields: Record<string, string>,
  unit: string,
  host: { wsl: boolean; apt: boolean } = { wsl: isWSL(), apt: commandExists('apt-get') },
): { commands: string[]; note: string } | null {
  if (fields.DOCKER_GROUP_STALE !== 'true') return null;
  const installAcl =
    fields.SETFACL_MISSING !== 'true'
      ? []
      : [host.apt ? 'sudo apt-get install -y acl' : '# first install the acl package (it provides setfacl)'];
  // Setup turns on linger, so logging out does not restart the user manager;
  // only a reboot (or a WSL shutdown) gives it the docker group.
  const lasting = host.wsl
    ? 'To fix it for good, run `wsl --shutdown` in PowerShell, then reopen your Linux terminal.'
    : 'A reboot fixes it for good.';
  return {
    commands: [
      ...installAcl,
      'sudo setfacl -m u:$(whoami):rw /var/run/docker.sock',
      `systemctl --user restart ${unit}`,
    ],
    note: `The setfacl fix lasts until Docker restarts. ${lasting}`,
  };
}
