/**
 * Redaction for text that lands in log files (host log, setup progression and
 * raw step logs). A floor, not a guarantee: callers should still avoid logging
 * secrets. Detection lives in the lists below; add an issuer's prefix there.
 */

export const SECRET_MASK = '[REDACTED]';
const MASK = SECRET_MASK;

// Start of a token: not inside a longer token-like run (so a long run is
// scanned once), or right after a JSON-escaped \n, \r or \t or an ANSI colour
// code, raw or JSON-escaped.
const START = String.raw`(?:(?<![A-Za-z0-9_.+-])|(?<=\\[nrt])|(?<=(?:\x1b|\\u001b)\[[0-9;]*m))`;
const startOf = (body: string, flags = 'g'): RegExp => new RegExp(START + body, flags);

/**
 * Keys with an issuer prefix, each with the exact prefix that may stay visible.
 * The hint (that prefix and the last 4 characters, as provider consoles show)
 * is used only when at least 16 payload characters stay hidden.
 */
const PREFIXED_KEYS: Array<[RegExp, RegExp]> = [
  [startOf(String.raw`sk-[A-Za-z0-9_-]{20,}`), /^sk-(?:ant-(?:api|admin|oat|sid)\d{2}-|proj-|svcacct-|admin-)?/], // Anthropic, OpenAI
  [startOf(String.raw`(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}`), /^gh[a-z]_/], // GitHub
  [startOf(String.raw`github_pat_[A-Za-z0-9_]{20,}`), /^github_pat_/],
  [startOf(String.raw`xox[abeoprs]-[A-Za-z0-9-]{10,}`), /^xox[a-z]-/], // Slack
  [startOf(String.raw`xapp-[A-Za-z0-9-]{10,}`), /^xapp-/],
  [startOf(String.raw`AKIA[0-9A-Z]{16}(?![A-Za-z0-9])`), /^AKIA/], // AWS access key id
  [startOf(String.raw`AIza[0-9A-Za-z_-]{35}(?![A-Za-z0-9_-])`), /^AIza/], // Google API key
];
const PREFIXED_KEYS_WHOLE = PREFIXED_KEYS.map(([re, prefix]) => [new RegExp(`^${re.source}$`), prefix] as const);

function hint(key: string, prefixRe: RegExp): string {
  const prefix = prefixRe.exec(key)?.[0] ?? '';
  return key.length - prefix.length - 4 >= 16 ? `${prefix}${MASK}…${key.slice(-4)}` : MASK;
}

const HINT = new RegExp(
  String.raw`^(?:${PREFIXED_KEYS.map(([, p]) => p.source.slice(1)).join('|')})\[REDACTED\]…[A-Za-z0-9_-]{4}$`,
);

/** Exactly a mask written here or upstream: `[redacted]`, `ghp_[REDACTED]…a1B2`, `<redacted: N bytes …>`. */
export function isRedactionPlaceholder(value: string): boolean {
  return /^(?:\[redacted\]|<redacted[^<>]*>)$/i.test(value) || HINT.test(value);
}

/** A secret-named field's value: the hint when it is exactly one prefixed key, else fully masked. */
export function maskSecretValue(value: string): string {
  for (const [re, prefix] of PREFIXED_KEYS_WHOLE) if (re.test(value)) return hint(value, prefix);
  return MASK;
}

/** Credential shapes without an issuer prefix, masked whole. */
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /\d{6,12}:[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/g, // Telegram bot token, also inside /bot<token>/ URLs
  startOf(String.raw`[MNO][A-Za-z0-9_-]{23,27}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,40}(?![A-Za-z0-9_-])`), // Discord
  startOf(String.raw`eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}`), // JWT
  // Webhook URLs whose path is the credential: only the token part is masked.
  /(?<=\/webhooks\/\d{6,}\/)[A-Za-z0-9_.-]{20,}/g, // Discord webhook and interaction tokens
  /(?<=hooks\.slack\.com\/(?:services|workflows|triggers)\/)[A-Za-z0-9_/-]{20,}/g,
];
// PEM body (with any Proc-Type/DEK-Info headers) up to its END line, or to the
// end of the base64 run when cut off; the backslash covers JSON-escaped newlines.
// Runs first: a mask inserted inside the body would end the match early.
const PEM_BLOCK =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----(?:(?!-----END )[A-Za-z0-9+/=\s\\:,-])*(?:-----END [A-Z ]*PRIVATE KEY-----)?/g;

/** Last word of a field, variable, flag or header name that holds a secret. */
const SECRET_NAME_WORDS = [
  'token',
  'secret',
  'password',
  'passwd',
  'api_key',
  'apikey',
  'private_key',
  'secret_key',
  'access_key',
  'secret_access_key',
  'credential',
  'credentials',
  'authorization',
  'cookie',
];

/** `max_tokens`, `secret_name` and `key` stay readable; `bot_token`, `x-api-key` do not. */
export function isSecretName(name: string): boolean {
  const snake = name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-.]/g, '_')
    .toLowerCase();
  return SECRET_NAME_WORDS.some((word) => snake === word || snake.endsWith(`_${word}`));
}

const NAME_WORDS = SECRET_NAME_WORDS.map((w) => w.replace(/_/g, '[_-]?')).join('|');
// A value runs to its closing quote when quoted (escapes included; in a
// JSON-escaped value \" closes and \\\" is a quote inside), else to the next
// space or delimiter.
const VALUE = String.raw`((?<=\\")(?:[^"\\\r\n]|\\\\\\"|\\\\|\\[^"\\\r\n])+|(?<=(?<!\\)")(?:[^"\\\r\n]|\\[^\r\n])+|(?<=')(?:[^'\\\r\n]|\\[^\r\n])+|(?:[^\s"'\\,;&]|\\(?![\\"'nrt]))+)`;
// NAME=value, NAME: value, "name":"value". The value may carry an auth scheme,
// which stays visible. Never crosses a line end.
const NAMED_VALUE = startOf(
  String.raw`([A-Za-z0-9_.-]*?(?:${NAME_WORDS}))(\\?["']?[ \t]*[:=][ \t]*\\?["']?)((?:Bearer|Basic|Token|Bot)[ \t]+)?${VALUE}`,
  'gi',
);
// --flag value, --flag "value"
const FLAG_VALUE = startOf(String.raw`(--[A-Za-z0-9_.-]*?(?:${NAME_WORDS}))([ \t]+["']?)${VALUE}`, 'gi');
// Every cookie in a Cookie / Set-Cookie header line, not just the first.
// Quoted cookie values may be raw or JSON-escaped; a JSON-escaped line end stops it.
const COOKIE_HEADER = startOf(
  String.raw`((?:set-)?cookie[ \t]*:[ \t]*)((?:[^\r\n"\\]|"[^"\r\n\\]*"|\\"[^"\r\n\\]*\\"|\\[^"nr\r\n])+)`,
  'gi',
);
const BEARER = /\b(bearer\s+)([A-Za-z0-9._~+/-]{16,}=*)/gi;
const URL_PASSWORD = startOf(String.raw`([a-z][a-z0-9+.-]*:\/\/[^\s/:@]*:)[^\s/@]+@`, 'gi');

// Unquoted words that say a secret is absent stay readable: `token: not configured`.
const PLACEHOLDER_WORDS = new Set(['true', 'false', 'null', 'undefined', 'none', 'not', 'unset', 'missing', 'empty']);

function maskNamed(match: string, name: string, sep: string, scheme: string | undefined, value: string): string {
  if (!isSecretName(name.replace(/^-+/, '')) || isRedactionPlaceholder(value)) return match;
  if (!/["']$/.test(sep) && PLACEHOLDER_WORDS.has(value.toLowerCase())) return match;
  return `${name}${sep}${scheme ?? ''}${MASK}`;
}

export function redactSecrets(text: string): string {
  let out = String(text).replace(PEM_BLOCK, MASK);
  for (const [pattern, prefix] of PREFIXED_KEYS) out = out.replace(pattern, (key) => hint(key, prefix));
  for (const pattern of SECRET_VALUE_PATTERNS) out = out.replace(pattern, MASK);
  out = out.replace(URL_PASSWORD, `$1${MASK}@`);
  out = out.replace(COOKIE_HEADER, (match, head: string, value: string) =>
    isRedactionPlaceholder(value) ? match : `${head}${MASK}`,
  );
  out = out.replace(NAMED_VALUE, maskNamed);
  out = out.replace(FLAG_VALUE, (match, name: string, sep: string, value: string) =>
    maskNamed(match, name, sep, undefined, value),
  );
  out = out.replace(BEARER, (match, scheme: string, value: string) =>
    isRedactionPlaceholder(value) ? match : `${scheme}${MASK}`,
  );
  return out;
}

const PEM_BEGIN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/g;
const PEM_END = /-----END [A-Z ]*PRIVATE KEY-----/;

/**
 * For output that arrives a line at a time: `redactSecrets` per line, plus a
 * PEM key's body lines, which only the BEGIN line identifies, until its END line.
 */
export function createLineRedactor(): (text: string) => string {
  let inKey = false;
  const line = (raw: string): string => {
    const end = raw.search(/\r?\n$|\r$/);
    const [body, eol] = end === -1 ? [raw, ''] : [raw.slice(0, end), raw.slice(end)];
    if (inKey) {
      const close = PEM_END.exec(body);
      if (!close) return MASK + eol;
      inKey = false;
      return MASK + redactSecrets(body.slice(close.index + close[0].length)) + eol;
    }
    const begins = [...body.matchAll(PEM_BEGIN)];
    const last = begins[begins.length - 1];
    if (last && !PEM_END.test(body.slice(last.index))) inKey = true;
    return redactSecrets(body) + eol;
  };
  return (text) =>
    text
      .split(/(?<=\n)/)
      .map(line)
      .join('');
}
