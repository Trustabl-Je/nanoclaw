/**
 * Delivery deadline: a channel send that never settles must not hold its
 * session (or the poll tick) forever, and a send that settles late must not
 * be posted twice.
 *
 * Same on-disk mailbox fixture as delivery.test.ts, under fake timers.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    DATA_DIR: '/tmp/nanoclaw-test-delivery-deadline',
    GROUPS_DIR: '/tmp/nanoclaw-test-delivery-deadline/groups',
  };
});

const TEST_DIR = '/tmp/nanoclaw-test-delivery-deadline';
const DEADLINE_MS = 60_000; // DELIVERY_DEADLINE_MS in delivery.ts
const GIVE_UP_MS = 60 * 60_000; // OVERDUE_GIVE_UP_MS in delivery.ts

import { closeDb, createAgentGroup, createMessagingGroup, initTestDb, runMigrations } from './db/index.js';
import {
  _resetOverdueDeliveriesForTesting,
  deliverSessionMessages,
  deliverToSessions,
  registerDeliveryAction,
  registerPostDeliveryHook,
  setDeliveryAdapter,
} from './delivery.js';
import { unguarded } from './guard/index.js';
import { log } from './log.js';
import { inboundDbPath, outboundDbPath } from './mailbox/sqlite/paths.js';
import { resolveSession } from './session-manager.js';
import type { Session } from './types.js';

function now(): string {
  return new Date().toISOString();
}

function insertOutbound(session: Session, msgId: string, kind = 'chat', content?: unknown): void {
  const db = new Database(outboundDbPath(session.agent_group_id, session.id));
  db.prepare(
    `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, content)
     VALUES (?, ?, ?, 'telegram:123', 'telegram', ?)`,
  ).run(msgId, now(), kind, JSON.stringify(content ?? { text: msgId }));
  db.close();
}

function deliveredRow(
  session: Session,
  msgId: string,
): { status: string; platform_message_id: string | null } | undefined {
  const db = new Database(inboundDbPath(session.agent_group_id, session.id), { readonly: true });
  const row = db.prepare('SELECT status, platform_message_id FROM delivered WHERE message_out_id = ?').get(msgId) as
    | { status: string; platform_message_id: string | null }
    | undefined;
  db.close();
  return row;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Adapter that records every send by message text and answers from `plan`:
 * a promise to hold the send on, or nothing for an immediate success.
 */
function recordingAdapter(plan: (text: string, call: number) => Promise<string> | undefined) {
  const calls: string[] = [];
  setDeliveryAdapter({
    async deliver(_ct, _pid, _tid, _kind, content) {
      const text = JSON.parse(content).text as string;
      calls.push(text);
      return (await plan(text, calls.filter((t) => t === text).length)) ?? `pm-${text}`;
    },
  });
  return calls;
}

/** Start a drain and report whether it finished, without awaiting it. */
function track(p: Promise<void>): { done: () => boolean; promise: Promise<void> } {
  let finished = false;
  const promise = p.then(() => {
    finished = true;
  });
  return { done: () => finished, promise };
}

let session: Session;

beforeEach(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await runMigrations(await initTestDb());
  await createAgentGroup({
    id: 'ag-1',
    name: 'Test Agent',
    folder: 'test-agent',
    agent_provider: null,
    created_at: now(),
  });
  await createMessagingGroup({
    id: 'mg-1',
    channel_type: 'telegram',
    platform_id: 'telegram:123',
    name: 'Test Chat',
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  ({ session } = await resolveSession('ag-1', 'mg-1', null, 'shared'));
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  _resetOverdueDeliveriesForTesting();
  await closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('delivery deadline', () => {
  it('a send that never settles stops holding the session at the deadline, with a warn log', async () => {
    insertOutbound(session, 'out-hung');
    const calls = recordingAdapter((text) => (text === 'out-hung' ? new Promise<string>(() => {}) : undefined));
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});

    const drain = track(deliverSessionMessages(session));
    await vi.advanceTimersByTimeAsync(DEADLINE_MS - 1);
    expect(drain.done()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(drain.done()).toBe(true);

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('deadline'),
      expect.objectContaining({ messageId: 'out-hung', sessionId: session.id, deadlineMs: DEADLINE_MS }),
    );
    expect(deliveredRow(session, 'out-hung')).toBeUndefined();

    // The session is not dark: a newer reply goes out on the next tick, and
    // the parked row is not sent a second time while its send is pending.
    insertOutbound(session, 'out-next');
    await deliverSessionMessages(session);
    expect(calls).toEqual(['out-hung', 'out-next']);
    expect(deliveredRow(session, 'out-next')?.status).toBe('delivered');
  });

  it('one hung session no longer holds the whole poll tick', async () => {
    const { session: other } = await resolveSession('ag-1', 'mg-1', 'thread-other', 'per-thread');
    insertOutbound(session, 'out-hung');
    insertOutbound(other, 'out-other');
    recordingAdapter((text) => (text === 'out-hung' ? new Promise<string>(() => {}) : undefined));
    vi.spyOn(log, 'warn').mockImplementation(() => {});

    const tick = track(deliverToSessions([session, other]));
    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    expect(tick.done()).toBe(true);
    expect(deliveredRow(other, 'out-other')?.status).toBe('delivered');
  });

  it('stops the drain at the overdue row; later rows go out on the next tick', async () => {
    insertOutbound(session, 'out-a');
    insertOutbound(session, 'out-b');
    const calls = recordingAdapter((text) => (text === 'out-a' ? new Promise<string>(() => {}) : undefined));
    vi.spyOn(log, 'warn').mockImplementation(() => {});

    const drain = track(deliverSessionMessages(session));
    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    await drain.promise;
    expect(calls).toEqual(['out-a']);

    await deliverSessionMessages(session);
    expect(calls).toEqual(['out-a', 'out-b']);
  });

  it('a late success marks the row delivered with its platform id and is never re-sent', async () => {
    insertOutbound(session, 'out-slow');
    const slow = deferred<string>();
    const calls = recordingAdapter((text) => (text === 'out-slow' ? slow.promise : undefined));
    vi.spyOn(log, 'warn').mockImplementation(() => {});

    const drain = track(deliverSessionMessages(session));
    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    await drain.promise;

    // Polls keep running while the send is still in flight.
    await deliverSessionMessages(session);
    await deliverSessionMessages(session);
    expect(calls).toEqual(['out-slow']);

    slow.resolve('pm-late');
    await vi.waitFor(() => expect(deliveredRow(session, 'out-slow')).toBeDefined());
    expect(deliveredRow(session, 'out-slow')).toEqual({ status: 'delivered', platform_message_id: 'pm-late' });

    await deliverSessionMessages(session);
    expect(calls).toEqual(['out-slow']);
  });

  it("a late success of the session's first reply still carries firstDelivery to post-delivery hooks", async () => {
    insertOutbound(session, 'out-first');
    const slow = deferred<string>();
    recordingAdapter((text) => (text === 'out-first' ? slow.promise : undefined));
    vi.spyOn(log, 'warn').mockImplementation(() => {});
    const seen: Array<{ id: string; firstDelivery: boolean }> = [];
    registerPostDeliveryHook((msg, hookSession, { firstDelivery }) => {
      if (hookSession.id === session.id) seen.push({ id: msg.id, firstDelivery });
    });

    const drain = track(deliverSessionMessages(session));
    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    await drain.promise;

    slow.resolve('pm-first');
    await vi.waitFor(() => expect(seen).toEqual([{ id: 'out-first', firstDelivery: true }]));

    insertOutbound(session, 'out-second');
    await deliverSessionMessages(session);
    expect(seen).toEqual([
      { id: 'out-first', firstDelivery: true },
      { id: 'out-second', firstDelivery: false },
    ]);
  });

  it('firstDelivery stays exactly-once when a parked first reply lands while a later drain is mid-send', async () => {
    insertOutbound(session, 'out-a');
    const slowA = deferred<string>();
    const slowB = deferred<string>();
    recordingAdapter((text) => (text === 'out-a' ? slowA.promise : text === 'out-b' ? slowB.promise : undefined));
    vi.spyOn(log, 'warn').mockImplementation(() => {});
    const seen: Array<{ id: string; firstDelivery: boolean }> = [];
    registerPostDeliveryHook((msg, hookSession, { firstDelivery }) => {
      if (hookSession.id === session.id) seen.push({ id: msg.id, firstDelivery });
    });

    const first = track(deliverSessionMessages(session));
    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    await first.promise;

    // B's drain reads the queue while nothing is delivered yet, then A lands.
    insertOutbound(session, 'out-b');
    const second = track(deliverSessionMessages(session));
    slowA.resolve('pm-a');
    await vi.waitFor(() => expect(seen).toEqual([{ id: 'out-a', firstDelivery: true }]));
    slowB.resolve('pm-b');
    await second.promise;

    expect(seen).toEqual([
      { id: 'out-a', firstDelivery: true },
      { id: 'out-b', firstDelivery: false },
    ]);
  });

  it('firstDelivery stays exactly-once when a send given up on lands while a later drain is mid-send', async () => {
    insertOutbound(session, 'out-a');
    const firstA = deferred<string>();
    const slowB = deferred<string>();
    const calls = recordingAdapter((text, call) => {
      if (text === 'out-a') return call === 1 ? firstA.promise : Promise.reject(new Error('still down'));
      return slowB.promise;
    });
    vi.spyOn(log, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(log, 'error').mockImplementation(() => {});
    const seen: Array<{ id: string; firstDelivery: boolean }> = [];
    registerPostDeliveryHook((msg, hookSession, { firstDelivery }) => {
      if (hookSession.id === session.id) seen.push({ id: msg.id, firstDelivery });
    });

    const first = track(deliverSessionMessages(session));
    await vi.advanceTimersByTimeAsync(DEADLINE_MS + GIVE_UP_MS);
    await first.promise;
    await vi.waitFor(() =>
      expect(error).toHaveBeenCalledWith(expect.stringContaining('never settled'), expect.anything()),
    );

    // This drain retries A (fails again) and waits on B; then A's first send lands.
    insertOutbound(session, 'out-b');
    const second = track(deliverSessionMessages(session));
    await vi.waitFor(() => expect(calls).toEqual(['out-a', 'out-a', 'out-b']));
    firstA.resolve('pm-a');
    await vi.waitFor(() => expect(seen).toEqual([{ id: 'out-a', firstDelivery: true }]));
    slowB.resolve('pm-b');
    await second.promise;

    expect(seen).toEqual([
      { id: 'out-a', firstDelivery: true },
      { id: 'out-b', firstDelivery: false },
    ]);
  });

  it('a late failure counts an attempt and the next tick retries the row', async () => {
    insertOutbound(session, 'out-flaky');
    const slow = deferred<string>();
    const calls = recordingAdapter((text, call) => (text === 'out-flaky' && call === 1 ? slow.promise : undefined));
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});

    const drain = track(deliverSessionMessages(session));
    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    await drain.promise;

    slow.reject(new Error('socket hang up'));
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        'Message delivery failed, will retry',
        expect.objectContaining({ messageId: 'out-flaky', attempt: 1 }),
      ),
    );

    await deliverSessionMessages(session);
    expect(calls).toEqual(['out-flaky', 'out-flaky']);
    expect(deliveredRow(session, 'out-flaky')?.status).toBe('delivered');
  });

  it('a send still unsettled after the give-up window counts as a failed attempt and is retried', async () => {
    insertOutbound(session, 'out-wedged');
    const calls = recordingAdapter((text, call) =>
      text === 'out-wedged' && call === 1 ? new Promise<string>(() => {}) : undefined,
    );
    vi.spyOn(log, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(log, 'error').mockImplementation(() => {});

    const drain = track(deliverSessionMessages(session));
    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    await drain.promise;

    await vi.advanceTimersByTimeAsync(GIVE_UP_MS - DEADLINE_MS - 1);
    await deliverSessionMessages(session);
    expect(calls).toEqual(['out-wedged']);

    await vi.advanceTimersByTimeAsync(DEADLINE_MS + 1);
    await vi.waitFor(() =>
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('never settled'),
        expect.objectContaining({ messageId: 'out-wedged', sessionId: session.id }),
      ),
    );

    await deliverSessionMessages(session);
    expect(calls).toEqual(['out-wedged', 'out-wedged']);
    expect(deliveredRow(session, 'out-wedged')?.status).toBe('delivered');
  });

  it('a send that lands after the give-up still marks the row delivered, so no later retry posts again', async () => {
    insertOutbound(session, 'out-very-late');
    const first = deferred<string>();
    const calls = recordingAdapter((text, call) => {
      if (text !== 'out-very-late') return undefined;
      if (call === 1) return first.promise;
      return Promise.reject(new Error('channel still down'));
    });
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(log, 'error').mockImplementation(() => {});

    const drain = track(deliverSessionMessages(session));
    await vi.advanceTimersByTimeAsync(DEADLINE_MS + GIVE_UP_MS);
    await drain.promise;
    await vi.waitFor(() =>
      expect(error).toHaveBeenCalledWith(expect.stringContaining('never settled'), expect.anything()),
    );

    // The retry fails too, so the row is still undelivered when the first
    // send finally lands.
    await deliverSessionMessages(session);
    expect(calls).toEqual(['out-very-late', 'out-very-late']);
    expect(warn).toHaveBeenCalledWith(
      'Message delivery failed, will retry',
      expect.objectContaining({ messageId: 'out-very-late', attempt: 2 }),
    );

    first.resolve('pm-very-late');
    await vi.waitFor(() => expect(deliveredRow(session, 'out-very-late')?.status).toBe('delivered'));
    await deliverSessionMessages(session);
    expect(calls).toHaveLength(2);
  });

  it('a hung system action is not run a second time while it is still pending', async () => {
    let runs = 0;
    registerDeliveryAction(
      'test_hang',
      async () => {
        runs++;
        await new Promise(() => {});
      },
      unguarded('test fixture'),
    );
    insertOutbound(session, 'out-action', 'system', { action: 'test_hang' });
    setDeliveryAdapter({ deliver: async () => 'pm' });
    vi.spyOn(log, 'warn').mockImplementation(() => {});
    vi.spyOn(log, 'info').mockImplementation(() => {});

    const drain = track(deliverSessionMessages(session));
    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    await drain.promise;
    await deliverSessionMessages(session);
    await deliverSessionMessages(session);
    expect(runs).toBe(1);
  });
});
