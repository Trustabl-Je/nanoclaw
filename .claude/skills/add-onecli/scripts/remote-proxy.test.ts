import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  advertisedProxy,
  checkRemoteProxy,
  readContainerConfig,
  remoteProxyHint,
  runtimeGateway,
} from './remote-proxy.js';

const TOKEN = 'aoc_secret_agent_token_value';
const GATEWAY = 'http://192.168.107.212:10254';
// What OneCLI 1.42/1.45 return from GET /v1/container-config: the proxy is
// http://x:<agent token>@${GATEWAY_BASE_URL}.
const config = (base: string) => ({
  env: { HTTPS_PROXY: `http://x:${TOKEN}@${base}`, HTTP_PROXY: `http://x:${TOKEN}@${base}` },
  caCertificate: '-----BEGIN CERTIFICATE-----',
});
const interfaces = {
  lo: [{ address: '127.0.0.1' }],
  docker0: [{ address: '172.17.0.1' }],
  eth0: [{ address: '192.168.107.215' }],
} as unknown as ReturnType<typeof os.networkInterfaces>;

describe('advertisedProxy', () => {
  it('reads the proxy the gateway hands agents', () => {
    expect(advertisedProxy(config('host.docker.internal:10255'))?.host).toBe('host.docker.internal:10255');
    expect(advertisedProxy({ env: { http_proxy: `http://x:${TOKEN}@10.0.0.9:10255` } })?.host).toBe('10.0.0.9:10255');
  });

  it('returns null for a config without a usable proxy', () => {
    for (const bad of [null, 'text', {}, { env: {} }, { env: { HTTPS_PROXY: 'not a url' } }]) {
      expect(advertisedProxy(bad)).toBeNull();
    }
  });
});

describe('remoteProxyHint', () => {
  it('warns when a remote gateway points agents at their own machine, with the exact fix', () => {
    for (const base of ['host.docker.internal:10255', 'localhost:10255', '127.0.0.1:10255']) {
      const hint = remoteProxyHint(GATEWAY, config(base), [], interfaces);
      expect(hint).toContain(base);
      expect(hint).toContain('GATEWAY_BASE_URL=192.168.107.212:10255');
      expect(hint).toContain('docker compose up -d');
      // Recreate on the running image: the installer does not persist ONECLI_VERSION.
      expect(hint).toContain("docker inspect -f '{{.Config.Image}}' onecli");
      expect(hint).not.toContain('env -u ONECLI_VERSION');
      expect(hint).not.toContain('\n');
    }
  });

  it('never prints the agent token or proxy credentials', () => {
    const hint = remoteProxyHint(GATEWAY, config('host.docker.internal:10255'), [], interfaces) ?? '';
    expect(hint).not.toContain(TOKEN);
    expect(hint).not.toContain('x:');
    expect(hint).not.toContain('@');
  });

  it('stays quiet once the gateway hands out an address agents can reach', () => {
    expect(remoteProxyHint(GATEWAY, config('192.168.107.212:10255'), [], interfaces)).toBeNull();
    expect(remoteProxyHint(GATEWAY, config('onecli.example.net:10255'), [], interfaces)).toBeNull();
  });

  it('stays quiet when the "remote" gateway is on this machine', () => {
    for (const url of ['http://127.0.0.1:10254', 'http://172.17.0.1:10254', 'http://192.168.107.215:10254']) {
      expect(remoteProxyHint(url, config('host.docker.internal:10255'), [], interfaces)).toBeNull();
    }
  });

  it('judges a gateway name by the addresses it resolves to', () => {
    const named = 'http://nanoclaw.local:10254';
    expect(remoteProxyHint(named, config('host.docker.internal:10255'), ['192.168.107.215'], interfaces)).toBeNull();
    expect(remoteProxyHint(named, config('host.docker.internal:10255'), ['192.168.107.212'], interfaces)).toContain(
      'GATEWAY_BASE_URL=nanoclaw.local:10255',
    );
  });

  it('stays quiet when the config has no proxy', () => {
    expect(remoteProxyHint(GATEWAY, { env: {} }, [], interfaces)).toBeNull();
  });
});

describe('readContainerConfig', () => {
  it('asks the default agent config with the API token, like the SDK', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(config('host.docker.internal:10255'))));
    const res = await readContainerConfig('http://192.168.107.212:10254/', TOKEN, fetchImpl);
    expect(res).toEqual({ ok: true, config: config('host.docker.internal:10255') });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    // Naming the seeded agent: without it OneCLI creates a default agent.
    expect(url).toBe('http://192.168.107.212:10254/v1/container-config?agent=default');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('falls back to the current default agent, and never asks without naming one', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url);
      if (url.endsWith('agent=default')) return new Response('{}', { status: 404 });
      if (url.endsWith('/v1/agents')) {
        return new Response(
          JSON.stringify([
            { identifier: 'ag-1', isDefault: false },
            { identifier: 'main', isDefault: true },
          ]),
        );
      }
      return new Response(JSON.stringify(config('host.docker.internal:10255')));
    });
    const res = await readContainerConfig(GATEWAY, TOKEN, fetchImpl as unknown as typeof fetch);
    expect(res.ok).toBe(true);
    expect(calls[calls.length - 1]).toBe(`${GATEWAY}/v1/container-config?agent=main`);
    expect(calls.every((u) => !u.endsWith('/v1/container-config'))).toBe(true);
  });

  it('gives up without an agent to read', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.endsWith('/v1/agents') ? new Response('[]') : new Response('{}', { status: 404 }),
    );
    expect(await readContainerConfig(GATEWAY, TOKEN, fetchImpl as unknown as typeof fetch)).toEqual({
      ok: false,
      reason: 'no agent to read',
    });
  });

  it('reports, never throws, when the config cannot be read', async () => {
    const refused = vi.fn(async () => new Response('nope', { status: 401 }));
    expect(await readContainerConfig(GATEWAY, undefined, refused)).toEqual({ ok: false, reason: 'status 401' });
    const down = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    expect((await readContainerConfig(GATEWAY, TOKEN, down)).ok).toBe(false);
    const garbled = vi.fn(async () => new Response('<html>'));
    expect((await readContainerConfig(GATEWAY, TOKEN, garbled)).ok).toBe(false);
  });

  it('keeps the token out of the failure reason', async () => {
    const down = vi.fn(async () => {
      throw new Error(`connect failed for Bearer ${TOKEN}`);
    });
    const res = await readContainerConfig(GATEWAY, TOKEN, down);
    expect(JSON.stringify(res)).not.toContain(TOKEN);
  });
});

describe('checkRemoteProxy', () => {
  const ok = () => vi.fn(async () => new Response(JSON.stringify(config('host.docker.internal:10255'))));
  const none = async () => [];

  it('warns for a remote gateway that hands out the default proxy', async () => {
    const res = await checkRemoteProxy(GATEWAY, TOKEN, { fetchImpl: ok(), lookup: none, interfaces });
    expect(res.status).toBe('warn');
    expect(res.hint).toContain('GATEWAY_BASE_URL=192.168.107.212:10255');
  });

  it('passes a remote gateway that hands out its own address', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(config('192.168.107.212:10255'))));
    expect((await checkRemoteProxy(GATEWAY, TOKEN, { fetchImpl, lookup: none, interfaces })).status).toBe('ok');
  });

  it('passes a gateway on this machine without asking it anything', async () => {
    const fetchImpl = ok();
    for (const url of ['http://127.0.0.1:10254', 'http://172.17.0.1:10254']) {
      expect((await checkRemoteProxy(url, TOKEN, { fetchImpl, lookup: none, interfaces })).status).toBe('ok');
    }
    const local = async () => ['192.168.107.215'];
    const named = await checkRemoteProxy('http://nanoclaw.local:10254', TOKEN, {
      fetchImpl,
      lookup: local,
      interfaces,
    });
    expect(named.status).toBe('ok');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('skips when the config cannot be read, and survives a failed lookup', async () => {
    const refused = vi.fn(async () => new Response('', { status: 401 }));
    const skipped = await checkRemoteProxy(GATEWAY, TOKEN, { fetchImpl: refused, lookup: none, interfaces });
    expect(skipped.status).toBe('skipped');
    expect(skipped.hint).toContain('status 401');
    const lookup = async () => {
      throw new Error('ENOTFOUND');
    };
    expect((await checkRemoteProxy(GATEWAY, TOKEN, { fetchImpl: ok(), lookup, interfaces })).status).toBe('warn');
  });
});

describe('runtimeGateway', () => {
  it('reads the URL and key the way the runtime does: process env, then .env', () => {
    const saved = { ONECLI_URL: GATEWAY, ONECLI_API_KEY: 'saved' };
    expect(runtimeGateway({}, saved)).toEqual({ url: GATEWAY, apiKey: 'saved' });
    expect(runtimeGateway({ ONECLI_API_KEY: 'exported' }, saved).apiKey).toBe('exported');
    expect(runtimeGateway({}, {})).toEqual({ url: undefined, apiKey: undefined });
  });
});

describe('check-proxy entry', () => {
  const entry = path.resolve('.claude/skills/add-onecli/scripts/check-proxy.ts');
  const tsx = path.resolve('node_modules/.bin/tsx');

  function runIn(envFile: string | null, extra: NodeJS.ProcessEnv = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onecli-proxy-'));
    try {
      if (envFile !== null) fs.writeFileSync(path.join(root, '.env'), envFile);
      const env = { ...process.env, ONECLI_URL: '', ONECLI_API_KEY: '', ...extra };
      return spawnSync(tsx, [entry], { cwd: root, env, encoding: 'utf-8' });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  it('prints exactly one JSON line and exits 0, even with debug logging on', () => {
    for (const [envFile, status] of [
      [null, 'skipped'],
      ['ONECLI_URL=http://127.0.0.1:10254\n', 'ok'],
      ['ONECLI_URL=http://nanoclaw-check.invalid:10254\n', 'skipped'],
      ['ONECLI_URL=not a url\n', 'skipped'],
    ] as const) {
      const res = runIn(envFile, { LOG_LEVEL: 'debug' });
      expect(res.status).toBe(0);
      const out = JSON.parse(res.stdout);
      expect(out.status).toBe(status);
      expect(out.hint).toBeTruthy();
      expect(res.stdout.trim().split('\n')).toHaveLength(1);
    }
  });
});
