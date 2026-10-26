/**
 * Transient send failures (rate limits, network errors, 408/429/5xx) back off
 * durably instead of burning the 3-attempt cap, and hold their destination so
 * later messages to it keep their order. The drain never sleeps: a message
 * that is not due yet is skipped until its `next_attempt_at`.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-delivery-backoff',
    GROUPS_DIR: '/tmp/nanoclaw-test-delivery-backoff/groups',
  };
});

const TEST_DIR = '/tmp/nanoclaw-test-delivery-backoff';

import { initTestDb, closeDb, runMigrations, createAgentGroup, createMessagingGroup } from './db/index.js';
import { getDb, hasTable } from './db/connection.js';
import { getDeliveryAttempt, recordDeliveryAttempt } from './db/coordination.js';
import { inboundDbPath, outboundDbPath } from './mailbox/sqlite/paths.js';
import { resolveSession } from './session-manager.js';
import { deliverSessionMessages, deliverToSessions, setDeliveryAdapter } from './delivery.js';

const T0 = new Date('2030-01-01T00:00:00.000Z').getTime();

function at(offsetMs: number): void {
  vi.setSystemTime(T0 + offsetMs);
}

/** The shape `@chat-adapter/shared` throws for a 429 (Teams sends no Retry-After). */
function rateLimited(retryAfterS?: number): Error {
  return Object.assign(new Error('Rate limited by teams'), {
    name: 'AdapterRateLimitError',
    code: 'RATE_LIMITED',
    adapter: 'teams',
    retryAfter: retryAfterS,
  });
}

/** Teams wraps every other API error, a 400 included, in a NetworkError. */
function teamsBadRequest(): Error {
  const inner = Object.assign(new Error('Bad Request'), { statusCode: 400 });
  return Object.assign(new Error('Teams API error during postMessage: Bad Request'), {
    name: 'NetworkError',
    code: 'NETWORK_ERROR',
    originalError: inner,
  });
}

async function seedChannel(id: string, platformId: string): Promise<void> {
  await createMessagingGroup({
    id,
    channel_type: 'teams',
    platform_id: platformId,
    name: id,
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at: new Date().toISOString(),
  });
}

async function seedAgent(): Promise<void> {
  await createAgentGroup({
    id: 'ag-1',
    name: 'Test Agent',
    folder: 'test-agent',
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
  await seedChannel('mg-1', 'teams:conv-1');
  await seedChannel('mg-2', 'teams:conv-2');
  // Sending outside the origin chat needs a destination row when the module's table exists.
  if (await hasTable(getDb(), 'agent_destinations')) {
    await getDb().run(
      `INSERT INTO agent_destinations (agent_group_id, local_name, target_type, target_id, created_at)
       VALUES ('ag-1', 'conv-2', 'channel', 'mg-2', ?)`,
      new Date().toISOString(),
    );
  }
}

function insertOutbound(sessionId: string, msgId: string, platformId: string, text: string): void {
  const db = new Database(outboundDbPath('ag-1', sessionId));
  db.prepare(
    `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, content)
     VALUES (?, datetime('now'), 'chat', ?, 'teams', ?)`,
  ).run(msgId, platformId, JSON.stringify({ text }));
  db.close();
}

function status(sessionId: string, msgId: string): string | undefined {
  const db = new Database(inboundDbPath('ag-1', sessionId), { readonly: true });
  const row = db.prepare('SELECT status FROM delivered WHERE message_out_id = ?').get(msgId) as
    | { status: string }
    | undefined;
  db.close();
  return row?.status;
}

/** Adapter double: records each send's text; `fail(text, n)` makes the next n sends of that text throw. */
function scriptedAdapter(failures: Map<string, () => Error>, budget: Map<string, number>) {
  const sent: string[] = [];
  setDeliveryAdapter({
    async deliver(_channelType, _platformId, _threadId, _kind, content) {
      const text = (JSON.parse(content) as { text: string }).text;
      sent.push(text);
      const left = budget.get(text) ?? 0;
      if (left > 0) {
        budget.set(text, left - 1);
        throw failures.get(text)!();
      }
      return `plat-${text}`;
    },
  });
  return sent;
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  at(0);
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = await initTestDb();
  await runMigrations(db);
  await seedAgent();
});

afterEach(async () => {
  vi.useRealTimers();
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('transient delivery failures back off instead of being dropped', () => {
  it('a Teams 429 with no Retry-After is retried at 2 s, 4 s, 8 s and then delivered', async () => {
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound(session.id, 'out-1', 'teams:conv-1', 'reply');
    const sent = scriptedAdapter(new Map([['reply', () => rateLimited()]]), new Map([['reply', 3]]));

    await deliverSessionMessages(session); // t=0: 429 #1, due at 2 s
    at(1_000);
    await deliverSessionMessages(session); // not due: no send
    expect(sent).toHaveLength(1);
    at(2_000);
    await deliverSessionMessages(session); // 429 #2, due at 6 s
    at(5_999);
    await deliverSessionMessages(session);
    expect(sent).toHaveLength(2);
    at(6_000);
    await deliverSessionMessages(session); // 429 #3, due at 14 s
    // The old cap of 3 would have given up here.
    expect(status(session.id, 'out-1')).toBeUndefined();
    expect((await getDeliveryAttempt('out-1'))?.next_attempt_at).toBe(new Date(T0 + 14_000).toISOString());
    at(14_000);
    await deliverSessionMessages(session);
    expect(sent).toHaveLength(4);
    expect(status(session.id, 'out-1')).toBe('delivered');
    expect(await getDeliveryAttempt('out-1')).toBeUndefined();
  });

  it('honours the Retry-After the adapter reports', async () => {
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound(session.id, 'out-1', 'teams:conv-1', 'reply');
    scriptedAdapter(new Map([['reply', () => rateLimited(30)]]), new Map([['reply', 1]]));

    await deliverSessionMessages(session);
    expect((await getDeliveryAttempt('out-1'))?.next_attempt_at).toBe(new Date(T0 + 30_000).toISOString());
  });

  it('holds the throttled destination so later messages to it keep their order; other destinations go on', async () => {
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound(session.id, 'a1', 'teams:conv-1', 'a1');
    insertOutbound(session.id, 'b1', 'teams:conv-2', 'b1');
    insertOutbound(session.id, 'a2', 'teams:conv-1', 'a2');
    const sent = scriptedAdapter(new Map([['a1', () => rateLimited()]]), new Map([['a1', 1]]));

    await deliverSessionMessages(session);
    expect(sent).toEqual(['a1', 'b1']);
    expect(status(session.id, 'a2')).toBeUndefined();
    expect(status(session.id, 'b1')).toBe('delivered');

    at(2_000);
    await deliverSessionMessages(session);
    expect(sent).toEqual(['a1', 'b1', 'a1', 'a2']);
    expect(status(session.id, 'a2')).toBe('delivered');
  });

  it('a held destination never delays a neighbour session in the same poll', async () => {
    const throttled = (await resolveSession('ag-1', 'mg-1', null, 'shared')).session;
    const neighbour = (await resolveSession('ag-1', 'mg-2', null, 'shared')).session;
    insertOutbound(throttled.id, 'slow', 'teams:conv-1', 'slow');
    const sent = scriptedAdapter(new Map([['slow', () => rateLimited(60)]]), new Map([['slow', 1]]));

    await deliverToSessions([throttled]);
    at(1_000);
    insertOutbound(neighbour.id, 'quick', 'teams:conv-2', 'quick');
    await deliverToSessions([throttled, neighbour]);
    expect(sent).toEqual(['slow', 'quick']);
    expect(status(neighbour.id, 'quick')).toBe('delivered');
  });

  it('keeps the backoff across a restart: a row from a previous life is not retried early', async () => {
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound(session.id, 'out-1', 'teams:conv-1', 'reply');
    await recordDeliveryAttempt({
      messageId: 'out-1',
      sessionId: session.id,
      now: new Date(T0 - 1_000).toISOString(),
      nextAttemptAt: new Date(T0 + 30_000).toISOString(),
      error: 'Rate limited by teams',
    });
    const sent = scriptedAdapter(new Map(), new Map());

    await deliverSessionMessages(session);
    expect(sent).toEqual([]);
    at(30_000);
    await deliverSessionMessages(session);
    expect(sent).toEqual(['reply']);
    expect(status(session.id, 'out-1')).toBe('delivered');
  });

  it('gives up after the transient horizon (about 30 minutes of backoff)', async () => {
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound(session.id, 'early', 'teams:conv-1', 'early');
    insertOutbound(session.id, 'late', 'teams:conv-2', 'late');
    for (let i = 0; i < 33; i++) {
      await recordDeliveryAttempt({
        messageId: 'early',
        sessionId: session.id,
        now: new Date(T0).toISOString(),
        nextAttemptAt: null,
      });
      await recordDeliveryAttempt({
        messageId: 'late',
        sessionId: session.id,
        now: new Date(T0).toISOString(),
        nextAttemptAt: null,
      });
    }
    await recordDeliveryAttempt({
      messageId: 'late',
      sessionId: session.id,
      now: new Date(T0).toISOString(),
      nextAttemptAt: null,
    });
    scriptedAdapter(
      new Map([
        ['early', () => rateLimited()],
        ['late', () => rateLimited()],
      ]),
      new Map([
        ['early', 1],
        ['late', 1],
      ]),
    );

    await deliverSessionMessages(session);
    // 34th failure: still inside the horizon, held for another 60 s.
    expect(status(session.id, 'early')).toBeUndefined();
    expect((await getDeliveryAttempt('early'))?.next_attempt_at).toBe(new Date(T0 + 60_000).toISOString());
    // 35th failure: past it — failed like any other give-up.
    expect(status(session.id, 'late')).toBe('failed');
    expect(await getDeliveryAttempt('late')).toBeUndefined();
  });
});

describe('permanent delivery failures behave as before', () => {
  it('a plain error is retried on the next polls and fails after 3 attempts, without holding later messages', async () => {
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound(session.id, 'bad', 'teams:conv-1', 'bad');
    insertOutbound(session.id, 'next', 'teams:conv-1', 'next');
    const sent = scriptedAdapter(new Map([['bad', () => new Error('card payload rejected')]]), new Map([['bad', 3]]));

    await deliverSessionMessages(session);
    expect(sent).toEqual(['bad', 'next']);
    await deliverSessionMessages(session);
    await deliverSessionMessages(session);
    expect(sent).toEqual(['bad', 'next', 'bad', 'bad']);
    expect(status(session.id, 'bad')).toBe('failed');
    expect((await getDeliveryAttempt('bad')) ?? null).toBeNull();
  });

  it('a Teams NetworkError that wraps an HTTP 400 is permanent, not a network blip', async () => {
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound(session.id, 'bad', 'teams:conv-1', 'bad');
    const sent = scriptedAdapter(new Map([['bad', teamsBadRequest]]), new Map([['bad', 3]]));

    await deliverSessionMessages(session);
    await deliverSessionMessages(session);
    await deliverSessionMessages(session);
    expect(sent).toHaveLength(3);
    expect(status(session.id, 'bad')).toBe('failed');
  });

  it('5xx and network codes are transient', async () => {
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound(session.id, 'gw', 'teams:conv-1', 'gw');
    insertOutbound(session.id, 'reset', 'teams:conv-2', 'reset');
    scriptedAdapter(
      new Map<string, () => Error>([
        ['gw', () => Object.assign(new Error('Bad Gateway'), { status: 502 })],
        ['reset', () => Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })],
      ]),
      new Map([
        ['gw', 1],
        ['reset', 1],
      ]),
    );

    await deliverSessionMessages(session);
    expect((await getDeliveryAttempt('gw'))?.next_attempt_at).toBe(new Date(T0 + 2_000).toISOString());
    expect((await getDeliveryAttempt('reset'))?.next_attempt_at).toBe(new Date(T0 + 2_000).toISOString());
  });
});

describe('review round 1', () => {
  it('writes the retry deadline in the same statement as the attempt count, so a crash between writes cannot lose it', async () => {
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound(session.id, 'held', 'teams:conv-1', 'held');
    scriptedAdapter(new Map([['held', () => rateLimited(300)]]), new Map([['held', 1]]));
    // The state a crash right after the first delivery_attempts write would leave behind.
    const db = getDb();
    const realRun = db.run.bind(db);
    const snapshot: { taken: boolean; row?: Awaited<ReturnType<typeof getDeliveryAttempt>> } = { taken: false };
    const spy = vi.spyOn(db, 'run').mockImplementation(async (sql: string, ...params: unknown[]) => {
      const result = await realRun(sql, ...params);
      if (!snapshot.taken && sql.includes('delivery_attempts')) {
        snapshot.taken = true;
        snapshot.row = await getDeliveryAttempt('held');
      }
      return result;
    });
    try {
      await deliverSessionMessages(session);
    } finally {
      spy.mockRestore();
    }
    expect(snapshot.taken).toBe(true);
    expect(snapshot.row?.next_attempt_at).toBe(new Date(T0 + 300_000).toISOString());
  });

  it('an HTTP 400 five links deep still overrides NetworkError', async () => {
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound(session.id, 'bad', 'teams:conv-1', 'bad');
    insertOutbound(session.id, 'next', 'teams:conv-1', 'next');
    let error: Error = Object.assign(new Error('Bad Request'), { statusCode: 400 });
    for (let i = 0; i < 4; i++) error = Object.assign(new Error('wrapped'), { name: 'NetworkError', cause: error });
    const sent = scriptedAdapter(new Map([['bad', () => error]]), new Map([['bad', 1]]));

    await deliverSessionMessages(session);
    expect((await getDeliveryAttempt('bad'))?.next_attempt_at).toBeNull();
    expect(sent).toEqual(['bad', 'next']);
  });

  it('a cause chain that loops, or is too deep to read, counts as permanent', async () => {
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound(session.id, 'loop', 'teams:conv-1', 'loop');
    insertOutbound(session.id, 'deep', 'teams:conv-2', 'deep');
    const loop = Object.assign(new Error('loop'), { name: 'NetworkError' }) as Error & { cause?: unknown };
    loop.cause = loop;
    let deep: Error = Object.assign(new Error('Bad Request'), { statusCode: 400 });
    for (let i = 0; i < 100; i++) deep = Object.assign(new Error('wrapped'), { name: 'NetworkError', cause: deep });
    scriptedAdapter(
      new Map<string, () => Error>([
        ['loop', () => loop],
        ['deep', () => deep],
      ]),
      new Map([
        ['loop', 1],
        ['deep', 1],
      ]),
    );

    await deliverSessionMessages(session);
    // A loop of NetworkErrors is a real network error; it is read once, not forever.
    expect((await getDeliveryAttempt('loop'))?.next_attempt_at).toBe(new Date(T0 + 2_000).toISOString());
    // A chain cut short is never assumed transient.
    expect((await getDeliveryAttempt('deep'))?.next_attempt_at).toBeNull();
  });
});
