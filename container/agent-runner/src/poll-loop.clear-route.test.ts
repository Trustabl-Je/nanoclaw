/**
 * After /clear, every answer must land in the thread of the message it
 * answers. Two things used to break that for the rest of the query:
 *  - /clear shared a batch with the next message, and the batch's reply
 *    route came from the /clear row, so that message was answered in the
 *    /clear thread;
 *  - the provider folded a message pushed mid-turn into the running turn
 *    (the Claude CLI does this between tool rounds) and answered both with
 *    one result, so the turn queue stayed one entry behind until the query
 *    ended.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from './mailbox/sqlite/connection.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { MockProvider } from './providers/mock.js';
import { runPollLoop } from './poll-loop.js';
import type { AgentQuery, ProviderEvent, ProviderExchange, QueryInput } from './providers/types.js';

const CONTRACT = { textDelivery: 'mid-turn-complete', commands: { formatting: 'xml' } } as const;

beforeEach(() => {
  initTestSessionDb();
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('slack-test', 'Slack Test', 'channel', 'slack', 'D123', NULL)`,
    )
    .run();
});
afterEach(() => closeSessionDb());

// Host-written rows carry even seq numbers in arrival order.
let seq = 0;
function insertMessage(id: string, text: string, threadId: string, trigger: 0 | 1 = 1) {
  seq += 2;
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, platform_id, channel_type, thread_id, trigger, content)
       VALUES (?, ?, 'chat', datetime('now'), 'pending', 'D123', 'slack', ?, ?, ?)`,
    )
    .run(id, seq, threadId, trigger, JSON.stringify({ sender: 'Admin', text }));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, ms = 5000) {
  const t = Date.now();
  while (!cond()) {
    if (Date.now() - t > ms) throw new Error('waitFor timeout');
    await sleep(25);
  }
}

/** Delivered chat rows as [text, thread]. */
function replies(): Array<[string, string | null]> {
  return getUndeliveredMessages()
    .filter((m) => m.kind === 'chat')
    .map((m) => [(JSON.parse(m.content) as { text: string }).text, m.thread_id]);
}
const replied = (text: string) => () => replies().some(([t]) => t === text);

/** The `ask:<label>` markers in a prompt, in order. */
const labels = (prompt: string) => [...prompt.matchAll(/ask:([\w-]+)/g)].map((m) => m[1]);

/**
 * Models the Claude CLI: a turn told to hold runs a "tool round" until the
 * test releases it; inputs pushed meanwhile are folded into that turn, and
 * its one result reports every input it answered.
 */
class FoldingProvider extends MockProvider {
  queries = 0;
  exchanges: ProviderExchange[] = [];
  onExchangeComplete(exchange: ProviderExchange): void {
    this.exchanges.push(exchange);
  }
  /** Prompts as they reached the provider, initial and pushed. */
  inputs: string[] = [];
  /** Turns currently in a held tool round. */
  holding = 0;
  private holds: Array<Promise<void>> = [];

  /** Make the next turn hold until the returned release is called. */
  hold(): () => void {
    let release!: () => void;
    this.holds.push(new Promise<void>((r) => (release = r)));
    return release;
  }

  query(input: QueryInput): AgentQuery {
    this.queries++;
    this.inputs.push(input.prompt);
    const inbox: string[] = [input.prompt];
    let wake: (() => void) | null = null;
    let aborted = false;
    let onAbort: () => void = () => {};
    const abortedP = new Promise<void>((r) => (onAbort = r));
    const self = this;
    const events = (async function* (): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: `fold-session-${self.queries}` };
      while (!aborted) {
        if (inbox.length === 0) {
          await new Promise<void>((r) => (wake = r));
          wake = null;
          continue;
        }
        const answered = [inbox.shift()!];
        const hold = self.holds.shift();
        if (hold) {
          self.holding++;
          await Promise.race([hold, abortedP]);
          self.holding--;
          answered.push(...inbox.splice(0));
        }
        if (aborted) return;
        const text = `<message to="slack-test">re: ${answered.flatMap(labels).join(' + ')}</message>`;
        yield { type: 'text', text };
        yield { type: 'result', text, ...(answered.length > 1 ? { answeredInputs: answered.length } : {}) };
      }
    })();
    return {
      push: (m) => {
        self.inputs.push(m);
        inbox.push(m);
        wake?.();
      },
      end: () => {},
      abort: () => {
        aborted = true;
        onAbort();
        wake?.();
      },
      events,
    };
  }
}

function startLoop(provider: FoldingProvider) {
  const controller = new AbortController();
  const loop = runPollLoop({
    provider,
    providerContract: CONTRACT,
    providerName: 'mock',
    cwd: '/tmp',
    signal: controller.signal,
  });
  return async () => {
    controller.abort();
    await loop.catch(() => {});
  };
}

const pushed = (provider: FoldingProvider, label: string) => () =>
  provider.inputs.some((p) => labels(p).includes(label));

describe('reply threads after /clear', () => {
  it('answers each later message in its own thread, not one behind', async () => {
    insertMessage('m0', 'ask:m0', 'thread-0');
    const provider = new FoldingProvider();
    const stop = startLoop(provider);
    try {
      await waitFor(replied('re: m0'));

      // The next question lands before the runner picks /clear up, and the
      // fresh session's first turn is still in a tool round when m3 arrives.
      const release = provider.hold();
      insertMessage('clear', '/clear', 'thread-clear');
      insertMessage('q', 'ask:q', 'thread-q');
      await waitFor(() => provider.holding === 1);
      insertMessage('m3', 'ask:m3', 'thread-3');
      await waitFor(pushed(provider, 'm3'));
      release();
      await waitFor(replied('re: q + m3'));

      insertMessage('m4', 'ask:m4', 'thread-4');
      await waitFor(replied('re: m4'));
      insertMessage('m5', 'ask:m5', 'thread-5');
      await waitFor(replied('re: m5'));
    } finally {
      await stop();
    }

    expect(replies()).toEqual([
      ['re: m0', 'thread-0'],
      ['Session cleared.', 'thread-clear'],
      ['re: q + m3', 'thread-q'],
      ['re: m4', 'thread-4'],
      ['re: m5', 'thread-5'],
    ]);
    // The exchange archive advances with the turns: the folded result
    // records both prompts, and later exchanges keep their own.
    expect(provider.exchanges.map((e) => labels(e.prompt))).toEqual([['m0'], ['q', 'm3'], ['m4'], ['m5']]);
  });
});

describe('reply threads after /clear — every arrival order', () => {
  // What made the report intermittent: whether the question reached the
  // runner before, with, or after /clear, and whether the next message
  // arrived while the answer was still in a tool round.
  const orders = [
    'question after "Session cleared."',
    'question batched after /clear',
    'question batched before /clear',
  ];
  for (const order of orders) {
    for (const folded of [false, true]) {
      it(`${order}, next message ${folded ? 'folded into' : 'after'} the answer`, async () => {
        insertMessage('m0', 'ask:m0', 'thread-0');
        const provider = new FoldingProvider();
        const stop = startLoop(provider);
        try {
          await waitFor(replied('re: m0'));
          const release = folded ? provider.hold() : () => {};
          if (order.endsWith('before /clear')) insertMessage('q', 'ask:q', 'thread-q');
          insertMessage('clear', '/clear', 'thread-clear');
          if (order.endsWith('after /clear')) insertMessage('q', 'ask:q', 'thread-q');
          if (order.startsWith('question after')) {
            await waitFor(replied('Session cleared.'));
            insertMessage('q', 'ask:q', 'thread-q');
          }
          if (folded) {
            await waitFor(() => provider.holding === 1);
            insertMessage('m3', 'ask:m3', 'thread-3');
            await waitFor(pushed(provider, 'm3'));
            release();
            await waitFor(replied('re: q + m3'));
          } else {
            await waitFor(replied('re: q'));
            insertMessage('m3', 'ask:m3', 'thread-3');
            await waitFor(replied('re: m3'));
          }
          insertMessage('m4', 'ask:m4', 'thread-4');
          await waitFor(replied('re: m4'));
        } finally {
          await stop();
        }

        const threadOf = Object.fromEntries(replies().map(([text, thread]) => [text, thread]));
        expect(threadOf['Session cleared.']).toBe('thread-clear');
        if (folded) expect(threadOf['re: q + m3']).toBe('thread-q');
        else expect([threadOf['re: q'], threadOf['re: m3']]).toEqual(['thread-q', 'thread-3']);
        expect(threadOf['re: m4']).toBe('thread-4');
      });
    }
  }
});

describe('/clear batched with accumulated context only', () => {
  it('starts no turn for the context, which is cleared with the session', async () => {
    const provider = new FoldingProvider();
    insertMessage('ctx', 'ambient ask:ctx', 'thread-ctx', 0);
    insertMessage('clear', '/clear', 'thread-clear');
    const stop = startLoop(provider);
    try {
      await waitFor(replied('Session cleared.'));
      await sleep(1200);
      expect(provider.queries).toBe(0);
      const ack = getOutboundDb().prepare(`SELECT status FROM processing_ack WHERE message_id = 'ctx'`).get();
      expect(ack).toEqual({ status: 'completed' });

      insertMessage('q', 'ask:q', 'thread-q');
      await waitFor(replied('re: q'));
    } finally {
      await stop();
    }
    expect(replies()).toEqual([
      ['Session cleared.', 'thread-clear'],
      ['re: q', 'thread-q'],
    ]);
  });
});
