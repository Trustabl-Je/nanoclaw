import { describe, expect, it } from 'vitest';

import { createLineRedactor, isSecretName, redactSecrets } from './secret-redaction.js';

// Fakes are assembled at runtime so no key-shaped literal sits in the source.
const fake = (prefix: string, body: string): string => prefix + body;
const A = (n: number): string => 'A'.repeat(n);

const FAKES = {
  anthropic: fake('sk-ant-api03-', `TESTKEY${A(40)}`),
  openai: fake('sk-proj-', `TESTKEY${A(40)}`),
  githubClassic: fake('ghp_', `TESTTOKEN${A(27)}`),
  githubOauth: fake('gho_', `TESTTOKEN${A(27)}`),
  githubFine: fake('github_pat_', `TESTTOKEN${A(70)}`),
  slackBot: fake('xoxb-', `0000000000-0000000000000-TESTTOKEN${A(15)}`),
  slackUser: fake('xoxp-', `0000000000-0000000000000-TESTTOKEN${A(15)}`),
  slackApp: fake('xapp-', `1-A0000000000-0000000000000-TESTTOKEN${A(40)}`),
  aws: fake('AKIA', 'TESTTESTTESTTEST'),
  telegram: fake('123456789:', `TESTTOKEN${A(26)}`),
  discord: fake('MTE', `${A(23)}.TESTAA.TESTTOKEN${A(29)}`),
  jwt: fake('eyJ', `hbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.TESTSIGNATURE${A(20)}`),
};

describe('redactSecrets: key-shaped values', () => {
  for (const [name, value] of Object.entries(FAKES)) {
    it(`removes a ${name} value from prose, JSON and URLs`, () => {
      for (const text of [
        `request failed with ${value} attached`,
        JSON.stringify({ nested: { value } }),
        `https://example.test/path/${value}/getMe?x=1`,
      ]) {
        const out = redactSecrets(text);
        expect(out).not.toContain(value);
        expect(out).toContain('[REDACTED]');
      }
    });
  }

  it('removes a whole PEM private key block', () => {
    const pem = `-----BEGIN PRIVATE KEY-----\nTESTKEY${A(40)}\n${A(40)}\n-----END PRIVATE KEY-----`;
    const out = redactSecrets(`loaded ${pem} ok`);
    expect(out).not.toContain('TESTKEY');
    expect(out).toBe('loaded [REDACTED] ok');
  });

  it('removes a PEM body that is JSON-escaped or cut off before its END line', () => {
    const escaped = JSON.stringify({
      key: `-----BEGIN RSA PRIVATE KEY-----\nTESTKEY${A(40)}\n-----END RSA PRIVATE KEY-----`,
    });
    expect(redactSecrets(escaped)).not.toContain('TESTKEY');
    const cut = `-----BEGIN OPENSSH PRIVATE KEY-----\nTESTKEY${A(40)}`.slice(0, 60);
    expect(redactSecrets(`stderr: ${cut}`)).not.toContain('TESTKEY');
  });

  it('removes values from JSON-escaped text', () => {
    const nested = JSON.stringify({ body: JSON.stringify({ apiKey: 'opaqueTESTVALUE' }) });
    expect(redactSecrets(nested)).toBe('{"body":"{\\"apiKey\\":\\"[REDACTED]\\"}"}');
    const multiline = JSON.stringify({ text: `line one\n${FAKES.githubClassic}\tTOKEN=opaqueTESTVALUE` });
    const out = redactSecrets(multiline);
    expect(out).not.toContain(FAKES.githubClassic);
    expect(out).not.toContain('opaqueTESTVALUE');
  });

  it('removes a Telegram token from a bot API URL', () => {
    const out = redactSecrets(`GET https://api.telegram.test/bot${FAKES.telegram}/getMe failed`);
    expect(out).not.toContain(FAKES.telegram.split(':')[1]);
  });

  it('removes the token segment of webhook URLs and keeps the rest of the path', () => {
    const interaction = `TESTTOKEN${A(60)}`;
    expect(redactSecrets(`path="/webhooks/123456789012345678/${interaction}/messages/@original"`)).toBe(
      'path="/webhooks/123456789012345678/[REDACTED]/messages/@original"',
    );
    const hook = `https://hooks.slack.test/services/T00000000/B00000000/TESTTOKEN${A(15)}`.replace('.test', '.com');
    expect(redactSecrets(`posting to ${hook}`)).toBe('posting to https://hooks.slack.com/services/[REDACTED]');
  });

  it('stays linear on long token-like runs', () => {
    const runs = [
      'eyJ-'.repeat(50_000),
      'a-'.repeat(100_000),
      'x'.repeat(200_000),
      'sk-'.repeat(60_000),
      '\x1b[1;2m'.repeat(40_000),
      'token="'.repeat(40_000),
      '\\"password\\":\\"'.repeat(20_000),
    ];
    const start = Date.now();
    for (const run of runs) redactSecrets(`${run} password`);
    expect(Date.now() - start).toBeLessThan(1000);
  });
});

describe('redactSecrets: auth headers, URLs and secret names', () => {
  it('keeps the scheme of an Authorization header and drops the credential', () => {
    expect(redactSecrets('Authorization: Bearer opaque-TESTTOKEN-123')).toBe('Authorization: Bearer [REDACTED]');
    expect(redactSecrets('{"authorization":"Basic dXNlcjpwYXNz"}')).toBe('{"authorization":"Basic [REDACTED]"}');
    expect(redactSecrets("curl -H 'Proxy-Authorization: Bearer opaqueTESTTOKEN'")).toBe(
      "curl -H 'Proxy-Authorization: Bearer [REDACTED]'",
    );
  });

  it('drops a bare bearer token outside a header', () => {
    expect(redactSecrets('sent bearer opaqueTESTTOKEN0123456789 upstream')).toBe('sent bearer [REDACTED] upstream');
  });

  it('drops api-key and cookie header values', () => {
    expect(redactSecrets('x-api-key: opaqueTESTKEY')).toBe('x-api-key: [REDACTED]');
    expect(redactSecrets('{"X-Api-Key":"opaqueTESTKEY","Content-Type":"json"}')).toBe(
      '{"X-Api-Key":"[REDACTED]","Content-Type":"json"}',
    );
    expect(redactSecrets('Cookie: session=opaqueTESTVALUE')).toBe('Cookie: [REDACTED]');
  });

  it('drops the password of a URL userinfo and keeps the host', () => {
    expect(redactSecrets('HTTPS_PROXY=http://user:opaqueTESTPASS@proxy.test:8080')).toBe(
      'HTTPS_PROXY=http://user:[REDACTED]@proxy.test:8080',
    );
  });

  it('drops values assigned to secret-named variables, flags and fields', () => {
    expect(redactSecrets('SLACK_BOT_TOKEN=opaqueTESTVALUE')).toBe('SLACK_BOT_TOKEN=[REDACTED]');
    expect(redactSecrets('export DISCORD_BOT_TOKEN="opaqueTESTVALUE"')).toBe('export DISCORD_BOT_TOKEN="[REDACTED]"');
    expect(redactSecrets('{"apiKey":"opaqueTESTVALUE","botToken":"opaqueTESTVALUE"}')).toBe(
      '{"apiKey":"[REDACTED]","botToken":"[REDACTED]"}',
    );
    expect(redactSecrets('cli --api-key opaqueTESTVALUE --name bot')).toBe('cli --api-key [REDACTED] --name bot');
    expect(redactSecrets('cli --token=opaqueTESTVALUE')).toBe('cli --token=[REDACTED]');
    expect(redactSecrets('client_secret: opaqueTESTVALUE')).toBe('client_secret: [REDACTED]');
  });
});

describe('redactSecrets: review cases', () => {
  it('masks a whole quoted value, for flags and assignments', () => {
    expect(redactSecrets('cli --token "opaqueTESTVALUE" --name bot')).toBe('cli --token "[REDACTED]" --name bot');
    expect(redactSecrets('PASSWORD="alpha beta" next')).toBe('PASSWORD="[REDACTED]" next');
  });

  it('masks every cookie in a Cookie header', () => {
    expect(redactSecrets('Cookie: theme=dark; session=opaqueSESSION')).toBe('Cookie: [REDACTED]');
  });

  it('finds a token wrapped in ANSI colour codes', () => {
    const out = redactSecrets(`\x1b[32m${FAKES.githubClassic}\x1b[0m`);
    expect(out).toBe('\x1b[32m[REDACTED]\x1b[0m');
  });

  it('does not let a prose word hide the assignment after it', () => {
    expect(redactSecrets('token password=opaqueTESTVALUE')).toBe('token password=[REDACTED]');
  });

  it('never reaches across a line end for a value', () => {
    expect(redactSecrets('TOKEN=\nECONNREFUSED')).toBe('TOKEN=\nECONNREFUSED');
  });
});

describe('redactSecrets: review round 2', () => {
  it('masks quoted values that contain backslashes, raw or JSON-escaped', () => {
    expect(redactSecrets('PASSWORD="\\secret" next')).toBe('PASSWORD="[REDACTED]" next');
    expect(redactSecrets('PASSWORD="ab\\cd"')).toBe('PASSWORD="[REDACTED]"');
    const nested = JSON.stringify({ body: JSON.stringify({ password: 'a\\b c', user: 'sam' }) });
    expect(redactSecrets(nested)).toBe(
      JSON.stringify({ body: JSON.stringify({ password: '[REDACTED]', user: 'sam' }) }),
    );
  });

  it('finds a token after a JSON-escaped ANSI colour code', () => {
    const out = redactSecrets(JSON.stringify({ stderr: `\x1b[32m${FAKES.githubClassic}\x1b[0m` }));
    expect(out).not.toContain(FAKES.githubClassic);
  });

  it('masks a Cookie header whose values are quoted', () => {
    expect(redactSecrets('Cookie: theme="dark"; session=opaqueSESSION')).toBe('Cookie: [REDACTED]');
  });

  it('masks a traditional encrypted PEM key with Proc-Type and DEK-Info headers', () => {
    const pem = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'Proc-Type: 4,ENCRYPTED',
      'DEK-Info: AES-128-CBC,0123456789ABCDEF',
      '',
      `TESTKEYBODY${A(40)}`,
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');
    const out = redactSecrets(`key ${pem} ok`);
    expect(out).toBe('key [REDACTED] ok');
  });
});

describe('redactSecrets: review round 3', () => {
  it('masks every cookie when the header line is JSON-escaped', () => {
    const out = redactSecrets(JSON.stringify({ stderr: 'Cookie: theme="dark"; session=opaqueSESSION' }));
    expect(out).toBe(JSON.stringify({ stderr: 'Cookie: [REDACTED]' }));
  });

  it('masks a JSON-escaped password that contains a quote', () => {
    const out = redactSecrets(JSON.stringify({ body: JSON.stringify({ password: 'prefix"opaqueSECRET' }) }));
    expect(out).toBe(JSON.stringify({ body: JSON.stringify({ password: '[REDACTED]' }) }));
  });
});

describe('createLineRedactor', () => {
  it('masks a PEM body that arrives one line per call', () => {
    const redact = createLineRedactor();
    const out = [
      'loading key\n',
      '-----BEGIN PRIVATE KEY-----\n',
      `TESTKEY${A(40)}\n`,
      `${A(40)}\n`,
      '-----END PRIVATE KEY-----\n',
      'done\n',
    ].map(redact);
    expect(out.join('')).not.toContain('TESTKEY');
    expect(out.join('')).not.toContain(A(40));
    expect(out[0]).toBe('loading key\n');
    expect(out[5]).toBe('done\n');
  });
});

describe('redactSecrets: leaves ordinary text alone', () => {
  it.each([
    'max_tokens=4096 tokenCount=3',
    'key="TELEGRAM_BOT_TOKEN" existed=true',
    'the token expired; ask the owner for a new one',
    'Basic setup complete',
    'image sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    'session 4f1c2b9e-1d2a-4c3b-9e8f-0a1b2c3d4e5f started',
    'https://example.test:8443/path?page=2',
    'sk-1 is not a key',
  ])('%s', (text) => {
    expect(redactSecrets(text)).toBe(text);
  });

  it('is idempotent', () => {
    const once = redactSecrets(`TOKEN=${FAKES.githubClassic} Authorization: Bearer ${FAKES.jwt}`);
    expect(redactSecrets(once)).toBe(once);
  });
});

describe('isSecretName', () => {
  it.each([
    'botToken',
    'SLACK_BOT_TOKEN',
    'apiKey',
    'x-api-key',
    'authorization',
    'cookie',
    'clientSecret',
    'password',
  ])('flags %s', (name) => expect(isSecretName(name)).toBe(true));
  it.each(['key', 'maxTokens', 'tokenCount', 'keyId', 'secretName', 'authMode'])('passes %s', (name) =>
    expect(isSecretName(name)).toBe(false),
  );
});
