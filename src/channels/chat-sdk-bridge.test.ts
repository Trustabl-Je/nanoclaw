import http from 'http';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Adapter, AdapterPostableMessage, CardElement, RawMessage } from 'chat';

import { gatewayApprovalPresentation } from '../gateway-approval-presentation.js';
import type { GatewayApprovalRequest } from '../gateway-providers/gateway-provider-registry.js';
import { CardTooLongError } from './ask-question.js';
import {
  attachmentBytesToBase64,
  CARD_TEXT_BLOCK_LENGTH,
  createChatSdkBridge,
  splitCardText,
  splitForLimit,
} from './chat-sdk-bridge.js';

vi.mock('../webhook-server.js', () => ({
  registerWebhookAdapter: vi.fn(),
}));

function stubAdapter(partial: Partial<Adapter>): Adapter {
  return { name: 'stub', ...partial } as unknown as Adapter;
}

interface PostCall {
  threadId: string;
  message: AdapterPostableMessage;
}

function makePostCapture() {
  const calls: PostCall[] = [];
  const postMessage = async (threadId: string, message: AdapterPostableMessage): Promise<RawMessage<unknown>> => {
    calls.push({ threadId, message });
    return { id: 'msg-stub', threadId, raw: {} };
  };
  return { calls, postMessage };
}

describe('splitForLimit', () => {
  it('returns a single chunk when text fits', () => {
    expect(splitForLimit('short text', 100)).toEqual(['short text']);
  });

  it('splits on paragraph boundaries when available', () => {
    const text = 'para one line one\npara one line two\n\npara two line one\npara two line two';
    const chunks = splitForLimit(text, 40);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(40);
  });

  it('falls back to line boundaries when no paragraph fits', () => {
    const text = 'alpha\nbravo\ncharlie\ndelta\necho\nfoxtrot';
    const chunks = splitForLimit(text, 15);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(15);
  });

  it('hard-cuts when no whitespace is available', () => {
    const text = 'a'.repeat(100);
    const chunks = splitForLimit(text, 30);
    expect(chunks.length).toBe(Math.ceil(100 / 30));
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(30);
    expect(chunks.join('')).toBe(text);
  });
});

describe('attachmentBytesToBase64', () => {
  const bytes = Buffer.from('telegram attachment');
  const expected = bytes.toString('base64');

  it('encodes a Buffer', () => {
    expect(attachmentBytesToBase64(Buffer.from(bytes))).toBe(expected);
  });

  it('encodes an ArrayBuffer (Telegram fetchData since 4.39)', () => {
    const ab = new ArrayBuffer(bytes.length);
    new Uint8Array(ab).set(bytes);
    expect(attachmentBytesToBase64(ab)).toBe(expected);
  });

  it('encodes only the viewed range of a Uint8Array', () => {
    const backing = new Uint8Array(bytes.length + 4);
    backing.set(bytes, 2);
    expect(attachmentBytesToBase64(backing.subarray(2, 2 + bytes.length))).toBe(expected);
  });
});

describe('createChatSdkBridge', () => {
  // The bridge is now transport-only: forward inbound events, relay outbound
  // ops. All per-wiring engage / accumulate / drop / subscribe decisions live
  // in the router (src/router.ts routeInbound / evaluateEngage) and are
  // exercised by host-core.test.ts end-to-end. These tests only cover the
  // bridge's narrow, platform-adjacent surface.

  it('omits openDM when the underlying Chat SDK adapter has none', () => {
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({}),
      supportsThreads: false,
    });
    expect(bridge.openDM).toBeUndefined();
  });

  it('exposes openDM when the underlying adapter has one, and delegates directly', async () => {
    const openDMCalls: string[] = [];
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({
        openDM: async (userId: string) => {
          openDMCalls.push(userId);
          return `thread::${userId}`;
        },
        channelIdFromThreadId: (threadId: string) => `stub:${threadId.replace(/^thread::/, '')}`,
      }),
      supportsThreads: false,
    });
    expect(bridge.openDM).toBeDefined();
    const platformId = await bridge.openDM!('user-42');
    // Delegation: adapter.openDM → adapter.channelIdFromThreadId, no chat.openDM in between.
    expect(openDMCalls).toEqual(['user-42']);
    expect(platformId).toBe('stub:user-42');
  });

  it('exposes subscribe (lets the router initiate thread subscription on mention-sticky engage)', () => {
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({}),
      supportsThreads: true,
    });
    expect(typeof bridge.subscribe).toBe('function');
  });

  it('reports an adapter transport probe when one is available', () => {
    let connected = false;
    const adapter = stubAdapter({}) as Adapter & { isConnected(): boolean };
    adapter.isConnected = () => connected;
    const bridge = createChatSdkBridge({ adapter, supportsThreads: true });

    expect(bridge.isConnected()).toBe(false);
    connected = true;
    expect(bridge.isConnected()).toBe(true);
  });

  it('keeps adapters without a transport probe available after setup', () => {
    const bridge = createChatSdkBridge({ adapter: stubAdapter({}), supportsThreads: true });
    expect(bridge.isConnected()).toBe(true);
  });
});

describe('createChatSdkBridge — instance identity', () => {
  it('default: name === channelType === adapter.name, instance undefined', () => {
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ name: 'slack' }),
      supportsThreads: true,
    });
    expect(bridge.name).toBe('slack');
    expect(bridge.channelType).toBe('slack');
    expect(bridge.instance).toBeUndefined();
  });

  it('named instance: name follows the instance, channelType stays the platform', () => {
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ name: 'slack' }),
      instance: 'slack-tester',
      supportsThreads: true,
    });
    expect(bridge.name).toBe('slack-tester');
    expect(bridge.channelType).toBe('slack');
    expect(bridge.instance).toBe('slack-tester');
  });

  it('rejects instance names that would break the webhook route or state delimiter', () => {
    for (const bad of ['a/b', 'a:b', 'a?b', 'a b']) {
      expect(() =>
        createChatSdkBridge({ adapter: stubAdapter({ name: 'slack' }), instance: bad, supportsThreads: true }),
      ).toThrow(/URL-safe/);
    }
  });

  it('rejects empty and whitespace-only instance names (config bug — fail loud)', () => {
    // '' is falsy: a truthiness guard would skip it, dead-ending the
    // webhook route ('/webhook/' + '') and collapsing the state namespace
    // into the default instance's unprefixed keyspace — the exact
    // cross-bot dedupe/lock collisions the namespace exists to prevent.
    for (const bad of ['', ' ', '   ', '\t']) {
      expect(() =>
        createChatSdkBridge({ adapter: stubAdapter({ name: 'slack' }), instance: bad, supportsThreads: true }),
      ).toThrow(/URL-safe/);
    }
  });
});

describe('createChatSdkBridge.setup — webhook route and state namespace', () => {
  // Real setup() over a stub adapter: Chat.initialize() needs a working
  // StateAdapter (chat_sdk_* tables) and an adapter.initialize — nothing
  // platform-side. registerWebhookAdapter is mocked at module level so we
  // can assert the (chat, adapterName, routingPath) triple.
  // runtimeMode is assigned inside initialize(), as the Telegram adapter does
  // when mode 'auto' resolves: a guard that reads it earlier sees undefined.
  function setupStubAdapter(runtimeMode?: 'webhook' | 'polling'): Adapter {
    const adapter = stubAdapter({ name: 'slack' }) as Adapter & { runtimeMode?: string };
    adapter.initialize = async () => {
      adapter.runtimeMode = runtimeMode;
    };
    return adapter;
  }

  beforeEach(async () => {
    const { initTestDb } = await import('../db/connection.js');
    const { runMigrations } = await import('../db/migrations/index.js');
    await runMigrations(await initTestDb());
    const { registerWebhookAdapter } = await import('../webhook-server.js');
    vi.mocked(registerWebhookAdapter).mockClear();
  });

  afterEach(async () => {
    const { closeDb } = await import('../db/connection.js');
    await closeDb();
  });

  const hostConfig = {
    onInbound: () => {},
    onInboundEvent: () => {},
    onMetadata: () => {},
    onAction: () => {},
  };

  it('named instance registers the webhook with adapterName as handler key and instance as route', async () => {
    const { registerWebhookAdapter } = await import('../webhook-server.js');
    const bridge = createChatSdkBridge({
      adapter: setupStubAdapter(),
      instance: 'slack-tester',
      supportsThreads: true,
    });
    await bridge.setup(hostConfig);
    expect(registerWebhookAdapter).toHaveBeenCalledTimes(1);
    const [, adapterName, routingPath] = vi.mocked(registerWebhookAdapter).mock.calls[0];
    expect(adapterName).toBe('slack');
    expect(routingPath).toBe('slack-tester');
    await bridge.teardown();
  });

  it('default instance registers the historical route', async () => {
    const { registerWebhookAdapter } = await import('../webhook-server.js');
    const bridge = createChatSdkBridge({ adapter: setupStubAdapter(), supportsThreads: true });
    await bridge.setup(hostConfig);
    const [, adapterName, routingPath] = vi.mocked(registerWebhookAdapter).mock.calls[0];
    expect(adapterName).toBe('slack');
    expect(routingPath ?? adapterName).toBe('slack');
    await bridge.teardown();
  });

  // Polling adapters (Telegram) pull updates themselves; a registered route
  // would lazily bind the shared webhook port, and a busy port then crashes a
  // Telegram-only host. Kill condition: delete the `runtimeMode === 'polling'`
  // branch in setup() and the polling case goes red.
  it('polling adapter (mode resolved inside initialize) registers no webhook route', async () => {
    const { registerWebhookAdapter } = await import('../webhook-server.js');
    const bridge = createChatSdkBridge({ adapter: setupStubAdapter('polling'), supportsThreads: true });
    await bridge.setup(hostConfig);
    expect(registerWebhookAdapter).not.toHaveBeenCalled();
    await bridge.teardown();
  });

  it('webhook adapter registers the route', async () => {
    const { registerWebhookAdapter } = await import('../webhook-server.js');
    const bridge = createChatSdkBridge({ adapter: setupStubAdapter('webhook'), supportsThreads: true });
    await bridge.setup(hostConfig);
    expect(registerWebhookAdapter).toHaveBeenCalledTimes(1);
    await bridge.teardown();
  });

  it('adapter without runtimeMode registers the route (non-Telegram adapters declare none)', async () => {
    const { registerWebhookAdapter } = await import('../webhook-server.js');
    const bridge = createChatSdkBridge({ adapter: setupStubAdapter(), supportsThreads: true });
    await bridge.setup(hostConfig);
    expect(registerWebhookAdapter).toHaveBeenCalledTimes(1);
    await bridge.teardown();
  });

  it('named instance namespaces Chat SDK state; default stays unprefixed (live-install constraint)', async () => {
    const { getDb } = await import('../db/connection.js');

    const named = createChatSdkBridge({
      adapter: setupStubAdapter(),
      instance: 'slack-tester',
      supportsThreads: true,
    });
    await named.setup(hostConfig);
    await named.subscribe!('slack:C1', 'slack:T1');

    const def = createChatSdkBridge({ adapter: setupStubAdapter(), supportsThreads: true });
    await def.setup(hostConfig);
    await def.subscribe!('slack:C1', 'slack:T1');

    const rows = await getDb().all<{ thread_id: string }>(
      'SELECT thread_id FROM chat_sdk_subscriptions ORDER BY thread_id',
    );
    expect(rows.map((r) => r.thread_id)).toEqual(['slack-tester:slack:T1', 'slack:T1']);

    await named.teardown();
    await def.teardown();
  });

  it('explicitly naming the primary instance after the platform stays on the unprefixed keyspace', async () => {
    const { getDb } = await import('../db/connection.js');
    const bridge = createChatSdkBridge({
      adapter: setupStubAdapter(),
      instance: 'slack', // explicit, but equal to adapter.name ⇒ default keyspace
      supportsThreads: true,
    });
    await bridge.setup(hostConfig);
    await bridge.subscribe!('slack:C1', 'slack:T9');
    const rows = await getDb().all<{ thread_id: string }>('SELECT thread_id FROM chat_sdk_subscriptions');
    expect(rows.map((r) => r.thread_id)).toEqual(['slack:T9']);
    await bridge.teardown();
  });
});

describe('createChatSdkBridge.deliver — ask_question cards (button styles)', () => {
  // Approval cards color their buttons (Slack: primary→green, danger→red).
  // The bridge must forward the normalized option style into Button() and
  // omit it when unset — an invalid style surviving to Block Kit would fail
  // the whole card with invalid_blocks (effective auto-deny).

  interface CapturedButton {
    type?: string;
    id?: string;
    label?: string;
    value?: string;
    style?: string;
  }

  function buttonsFrom(calls: PostCall[]): CapturedButton[] {
    const msg = calls[0].message as {
      card?: { children?: Array<{ type?: string; children?: CapturedButton[] }> };
    };
    const actionsRow = msg.card?.children?.find((c) => c.type === 'actions');
    expect(actionsRow).toBeDefined();
    return actionsRow?.children ?? [];
  }

  it('passes each option style through to the Button, and omits it when unset', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    await bridge.deliver('slack:C1', null, {
      kind: 'chat-sdk',
      content: {
        type: 'ask_question',
        questionId: 'q-1',
        title: 'Approval needed',
        question: 'Allow the tool call?',
        options: [
          { label: 'Approve', style: 'primary' },
          { label: 'Deny', style: 'danger' },
          'Skip', // string shorthand — never styled
        ],
      },
    });
    expect(calls).toHaveLength(1);
    const buttons = buttonsFrom(calls);
    expect(buttons.map((b) => b.label)).toEqual(['Approve', 'Deny', 'Skip']);
    expect(buttons.map((b) => b.style)).toEqual(['primary', 'danger', undefined]);
  });

  it('drops invalid styles before they reach the Button (delivery goes through normalizeOptions)', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    await bridge.deliver('slack:C1', null, {
      kind: 'chat-sdk',
      content: {
        type: 'ask_question',
        questionId: 'q-2',
        title: 'Approval needed',
        question: 'Allow the tool call?',
        options: [{ label: 'Approve', style: 'chartreuse' }],
      },
    });
    const buttons = buttonsFrom(calls);
    expect(buttons).toHaveLength(1);
    expect(buttons[0].style).toBeUndefined();
  });

  it('retains the approval body and replaces buttons with a muted timeout resolution', async () => {
    const edits: PostCall[] = [];
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({
        editMessage: async (threadId, _messageId, message) => {
          edits.push({ threadId, message });
          return { id: 'msg-1', threadId, raw: {} };
        },
      }),
      supportsThreads: false,
    });

    await bridge.deliver('slack:C1', null, {
      kind: 'chat-sdk',
      content: {
        operation: 'edit',
        messageId: 'msg-1',
        text: 'Credentials Request\n\n*Agent:* Andy\n*Action:* Send email\n\n⏱️ Timed out — no response',
        terminalCard: {
          title: 'Credentials Request',
          question: '*Agent:* Andy\n*Action:* Send email',
          resolution: '⏱️ Timed out — no response',
        },
      },
    });

    expect(edits).toHaveLength(1);
    const edited = edits[0].message as {
      card: { title: string; children: Array<{ type: string; content?: string; style?: string }> };
    };
    expect(edited.card.title).toBe('Credentials Request');
    expect(edited.card.children).toEqual([
      { type: 'text', content: '*Agent:* Andy\n*Action:* Send email' },
      { type: 'text', content: '⏱️ Timed out — no response', style: 'muted' },
    ]);
    expect(edited.card.children.some((child) => child.type === 'actions')).toBe(false);
  });

  it('runs open and resolved card text through escapeCardText, leaving the title alone', async () => {
    const { calls, postMessage } = makePostCapture();
    const edits: PostCall[] = [];
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({
        postMessage,
        editMessage: async (threadId, _messageId, message) => {
          edits.push({ threadId, message });
          return { id: 'msg-1', threadId, raw: {} };
        },
      }),
      supportsThreads: false,
      escapeCardText: (t) => `[${t}]`,
    });

    await bridge.deliver('slack:D1', null, {
      kind: 'chat-sdk',
      content: {
        type: 'ask_question',
        questionId: 'q-3',
        title: 'Approval needed',
        question: 'Allow?',
        options: ['Approve'],
      },
    });
    const posted = calls[0].message as {
      card: { title: string; children: Array<{ type: string; content?: string }> };
      fallbackText: string;
    };
    expect(posted.card.title).toBe('Approval needed');
    expect(posted.card.children[0]).toEqual({ type: 'text', content: '[Allow?]' });
    expect(posted.fallbackText).toBe('Approval needed\n\n[Allow?]\nOptions: Approve');

    await bridge.deliver('slack:D1', null, {
      kind: 'chat-sdk',
      content: {
        operation: 'edit',
        messageId: 'msg-1',
        terminalCard: { title: 'Approval needed', question: 'Allow?', resolution: 'Approve by Ann' },
      },
    });
    const edited = edits[0].message as {
      card: { title: string; children: Array<{ type: string; content?: string; style?: string }> };
    };
    expect(edited.card.title).toBe('Approval needed');
    expect(edited.card.children).toEqual([
      { type: 'text', content: '[Allow?]' },
      { type: 'text', content: '[Approve by Ann]', style: 'muted' },
    ]);
  });

  const CARD_TITLE = 'Approval needed';
  function questionCard(question: string, title = CARD_TITLE) {
    return {
      kind: 'chat-sdk',
      content: { type: 'ask_question', questionId: 'q-len', title, question, options: ['Approve'] },
    };
  }

  function postedCards(calls: PostCall[]) {
    return calls.map(({ message }) => {
      const card = (message as { card: { title?: string; children: Array<{ type: string; content?: string }> } }).card;
      return {
        title: card.title,
        text: card.children.filter((child) => child.type === 'text').map((child) => child.content ?? ''),
        hasButtons: card.children.some((child) => child.type === 'actions'),
      };
    });
  }

  function postedBlocks(calls: PostCall[]): { text: string[]; hasButtons: boolean } {
    const posted = calls[0].message as { card: { children: Array<{ type: string; content?: string }> } };
    return {
      text: posted.card.children.filter((child) => child.type === 'text').map((child) => child.content ?? ''),
      hasButtons: posted.card.children.some((child) => child.type === 'actions'),
    };
  }

  it('posts a full-size gateway summary card whole, in text blocks under the block cap', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({ adapter: stubAdapter({ postMessage }), supportsThreads: false });
    const { title, question } = gatewayApprovalPresentation({
      title: 'Legacy',
      question: 'Legacy question',
      summary: {
        agent: 'Nano',
        action: 'Read external data',
        resource: 'GET api.example.test/repos',
        reason: 'Policy requires approval',
        details: Array.from({ length: 6 }, (_, i) => ({ label: `Detail ${i}`, value: `${i}`.repeat(600) })),
      },
    } as GatewayApprovalRequest);
    expect(question.length).toBeGreaterThan(CARD_TEXT_BLOCK_LENGTH);

    await bridge.deliver('slack:D1', null, questionCard(question, title));
    const { text, hasButtons } = postedBlocks(calls);
    expect(text.length).toBeGreaterThan(1);
    for (const block of text) expect(block.length).toBeLessThanOrEqual(CARD_TEXT_BLOCK_LENGTH);
    expect(text.join('')).toBe(question);
    expect(hasButtons).toBe(true);
  });

  it("overflows a card over the channel's declared limit, counting the title", async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
      maxCardTextLength: 300,
    });

    const fits = 'x'.repeat(300 - CARD_TITLE.length);
    await bridge.deliver('slack:D1', null, questionCard(fits));
    expect(postedCards(calls)).toEqual([{ title: CARD_TITLE, text: [fits], hasButtons: true }]);
    calls.length = 0;
    await bridge.deliver('slack:D1', null, questionCard(`${fits}x`));
    const cards = postedCards(calls);
    expect(cards.length).toBeGreaterThan(2);
    expect(cards.at(-1)!.hasButtons).toBe(true);
    for (const card of cards) expect((card.title ?? '').length + card.text.join('\n').length).toBeLessThanOrEqual(300);
  });

  it('counts the fences a split adds toward the declared limit', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
      escapeCardText: (t) => t.replace(/&/g, '&amp;'),
      maxCardTextLength: 3000,
    });

    // Title + escaped text is exactly 3,000; the split's extra fences push it over.
    const question = '```\n' + '&'.repeat(598) + '\n```';
    await bridge.deliver('slack:D1', null, questionCard(question, 'OK'));
    const cards = postedCards(calls);
    expect(cards.length).toBeGreaterThan(1);
    expect(cards.slice(0, -1).some((card) => card.hasButtons)).toBe(false);
  });

  it('splits the resolved card the same way as the open one', async () => {
    const edits: PostCall[] = [];
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({
        editMessage: async (threadId, _messageId, message) => {
          edits.push({ threadId, message });
          return { id: 'msg-1', threadId, raw: {} };
        },
      }),
      supportsThreads: false,
      escapeCardText: (t) => t.replace(/&/g, '&amp;'),
    });

    const question = '&'.repeat(1000);
    await bridge.deliver('slack:D1', null, {
      kind: 'chat-sdk',
      content: {
        operation: 'edit',
        messageId: 'msg-1',
        terminalCard: { title: 'Approval needed', question, resolution: 'Approved' },
      },
    });
    const edited = edits[0].message as { card: { children: Array<{ content?: string; style?: string }> } };
    const blocks = edited.card.children.filter((child) => !child.style).map((child) => child.content ?? '');
    expect(blocks.length).toBeGreaterThan(1);
    for (const block of blocks) expect(block.length).toBeLessThanOrEqual(CARD_TEXT_BLOCK_LENGTH);
    expect(blocks.join('')).toBe('&amp;'.repeat(1000));
    expect(edited.card.children.at(-1)).toEqual({ type: 'text', content: 'Approved', style: 'muted' });
  });

  it('measures the declared limit after escaping', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
      escapeCardText: (t) => t.replace(/&/g, '&amp;'),
      maxCardTextLength: 300,
    });

    await bridge.deliver('slack:D1', null, questionCard('&'.repeat(70)));
    const cards = postedCards(calls);
    expect(cards.length).toBeGreaterThan(1);
    expect(cards.flatMap((card) => card.text.slice(1)).join('')).toContain('&amp;'.repeat(70));
  });

  describe('ask_question cards a channel cannot show whole', () => {
    // A stand-in channel that shows at most `max` characters of title plus text per card.
    const texts = (card: CardElement) =>
      card.children.flatMap((child) => (child.type === 'text' ? [child.content] : []));
    const hasActions = (card: CardElement) => card.children.some((child) => child.type === 'actions');
    const within = (max: number, card: { title?: string; text: string[] }) =>
      (card.title ?? '').length + card.text.join('\n').length <= max;
    const fitsWithin = (max: number) => (card: CardElement) => within(max, { title: card.title, text: texts(card) });
    const notice = (parts: number) => `The full request is in the ${parts} messages marked ref q-len above.`;
    /** The request text the parts carry, without their labels. */
    const partText = (parts: Array<{ text: string[] }>) => parts.flatMap((card) => card.text.slice(1)).join('');
    const LONG = Array.from({ length: 20 }, (_, i) => `Line ${i}: ${'w'.repeat(40)}`).join('\n');

    function numberedPosts(failOn?: number) {
      const calls: PostCall[] = [];
      const postMessage = async (threadId: string, message: AdapterPostableMessage): Promise<RawMessage<unknown>> => {
        if (calls.length + 1 === failOn) throw new Error('platform down');
        calls.push({ threadId, message });
        return { id: `msg-${calls.length}`, threadId, raw: {} };
      };
      return { calls, postMessage };
    }

    it('posts the full text first, then a short card with the buttons', async () => {
      const { calls, postMessage } = numberedPosts();
      const bridge = createChatSdkBridge({
        adapter: stubAdapter({ postMessage }),
        supportsThreads: false,
        cardFits: fitsWithin(300),
      });

      const id = await bridge.deliver('slack:D1', null, questionCard(LONG));
      const cards = postedCards(calls);
      const parts = cards.slice(0, -1);
      expect(parts.length).toBeGreaterThan(1);
      expect(parts.some((card) => card.hasButtons)).toBe(false);
      expect(parts[0].title).toBe(CARD_TITLE);
      parts.forEach((card, i) => expect(card.text[0]).toBe(`Request ref q-len, part ${i + 1} of ${parts.length}`));
      expect(partText(parts)).toBe(LONG);
      expect(cards.at(-1)).toEqual({ title: CARD_TITLE, text: [notice(parts.length)], hasButtons: true });
      expect(id).toBe(`msg-${cards.length}`);
      for (const card of cards) expect(within(300, card)).toBe(true);
    });

    it('labels every part so concurrent requests stay apart, even with similar ids', async () => {
      const { calls, postMessage } = numberedPosts();
      const bridge = createChatSdkBridge({
        adapter: stubAdapter({ postMessage }),
        supportsThreads: false,
        cardFits: fitsWithin(300),
      });
      const ask = (questionId: string, fill: string) =>
        bridge.deliver('slack:D1', null, {
          kind: 'chat-sdk',
          content: {
            type: 'ask_question',
            questionId,
            title: CARD_TITLE,
            question: fill.repeat(700),
            options: ['Approve'],
          },
        });
      await Promise.all([ask('ga-0000abcdef', 'a'), ask('ga-1111abcdef', 'b')]);
      for (const [ref, fill] of [
        ['ga-0000abcdef', 'a'],
        ['ga-1111abcdef', 'b'],
      ]) {
        const mine = postedCards(calls).filter((card) => card.text[0]?.includes(`ref ${ref}`));
        expect(partText(mine.filter((card) => !card.hasButtons))).toBe(fill.repeat(700));
        expect(mine.filter((card) => card.hasButtons)).toHaveLength(1);
      }
    });

    it('splits text smaller when one block does not fit a message', async () => {
      const { calls, postMessage } = numberedPosts();
      const bridge = createChatSdkBridge({
        adapter: stubAdapter({ postMessage }),
        supportsThreads: false,
        cardFits: fitsWithin(600),
      });
      const question = 'z'.repeat(1800);

      await bridge.deliver('slack:D1', null, questionCard(question));
      const cards = postedCards(calls);
      expect(partText(cards.slice(0, -1))).toBe(question);
      for (const card of cards) expect(within(600, card)).toBe(true);
    });

    it('moves a title too long for a part into the text', async () => {
      const { calls, postMessage } = numberedPosts();
      // Titles over 100 never fit; text up to 300 does.
      const cardFits = (card: CardElement) => (card.title ?? '').length <= 100 && fitsWithin(400)(card);
      const bridge = createChatSdkBridge({ adapter: stubAdapter({ postMessage }), supportsThreads: false, cardFits });
      const title = 'T'.repeat(150);

      await bridge.deliver('slack:D1', null, questionCard(LONG, title));
      const cards = postedCards(calls);
      const parts = cards.slice(0, -1);
      expect(parts[0].title).toBe('Approval request');
      expect(partText(parts)).toBe(`${title}\n\n${LONG}`);
      expect(cards.at(-1)!.title).toBe('Approval request');
      expect(cards.at(-1)!.hasButtons).toBe(true);
    });

    it('posts nothing when the text cannot fit even split', async () => {
      const { calls, postMessage } = numberedPosts();
      const bridge = createChatSdkBridge({
        adapter: stubAdapter({ postMessage }),
        supportsThreads: false,
        cardFits: (card) => hasActions(card) && texts(card).join('').length < 60,
      });
      await expect(bridge.deliver('slack:D1', null, questionCard('x'.repeat(500)))).rejects.toThrow(CardTooLongError);
      expect(calls).toHaveLength(0);
    });

    it('posts nothing when even the short card with the buttons cannot fit', async () => {
      const { calls, postMessage } = numberedPosts();
      const bridge = createChatSdkBridge({
        adapter: stubAdapter({ postMessage }),
        supportsThreads: false,
        cardFits: (card) => !hasActions(card),
      });
      await expect(bridge.deliver('slack:D1', null, questionCard('x'.repeat(500)))).rejects.toThrow(CardTooLongError);
      expect(calls).toHaveLength(0);
    });

    it('posts no buttons when part of the text fails to post', async () => {
      const { calls, postMessage } = numberedPosts(2);
      const bridge = createChatSdkBridge({
        adapter: stubAdapter({ postMessage }),
        supportsThreads: false,
        cardFits: fitsWithin(300),
      });
      await expect(bridge.deliver('slack:D1', null, questionCard(LONG))).rejects.toThrow('platform down');
      expect(postedCards(calls).some((card) => card.hasButtons)).toBe(false);
    });

    function editCapture() {
      const edits: PostCall[] = [];
      const editMessage = async (threadId: string, _messageId: string, message: AdapterPostableMessage) => {
        edits.push({ threadId, message });
        return { id: 'msg-1', threadId, raw: {} };
      };
      const editedTexts = () =>
        (edits[0].message as { card: { children: Array<{ content?: string }> } }).card.children.map(
          (child) => child.content,
        );
      return { edits, editMessage, editedTexts };
    }

    it('keeps a resolved card short when its request was posted above it', async () => {
      const { registerQuestionRenderResolver } = await import('./question-render-registry.js');
      registerQuestionRenderResolver((id) => (id === 'q-len' ? { title: CARD_TITLE, options: [] } : undefined));
      const { editMessage, editedTexts } = editCapture();
      const bridge = createChatSdkBridge({
        adapter: stubAdapter({ editMessage }),
        supportsThreads: false,
        cardFits: fitsWithin(300),
      });
      await bridge.deliver('slack:D1', null, {
        kind: 'chat-sdk',
        content: {
          questionId: 'q-len',
          operation: 'edit',
          messageId: 'msg-1',
          terminalCard: { title: CARD_TITLE, question: 'y'.repeat(1000), resolution: 'Approved' },
        },
      });
      expect(editedTexts()).toEqual(['Request ref q-len', 'Approved']);
    });

    it('keeps only the resolution when text and resolution do not fit together', async () => {
      const { editMessage, editedTexts } = editCapture();
      const bridge = createChatSdkBridge({
        adapter: stubAdapter({ editMessage }),
        supportsThreads: false,
        maxCardTextLength: 70,
      });
      await bridge.deliver('slack:D1', null, {
        kind: 'chat-sdk',
        content: {
          operation: 'edit',
          messageId: 'msg-1',
          terminalCard: { title: CARD_TITLE, question: 'x'.repeat(50), resolution: 'Approved' },
        },
      });
      expect(editedTexts()).toEqual(['Approved']);
    });

    it('shortens the title too when even the resolution alone does not fit with it', async () => {
      const { edits, editMessage, editedTexts } = editCapture();
      const bridge = createChatSdkBridge({
        adapter: stubAdapter({ editMessage }),
        supportsThreads: false,
        maxCardTextLength: 300,
      });
      const resolution = `Approved by ${'a'.repeat(80)}`;
      await bridge.deliver('slack:D1', null, {
        kind: 'chat-sdk',
        content: {
          operation: 'edit',
          messageId: 'msg-1',
          terminalCard: { title: 'T'.repeat(220), question: 'x'.repeat(50), resolution },
        },
      });
      expect((edits[0].message as { card: { title: string } }).card.title).toBe('Approval request');
      expect(editedTexts()).toEqual([resolution]);
    });

    it('lets the channel measure the styled card it will render', async () => {
      const { editMessage, editedTexts } = editCapture();
      // Like Discord: muted text renders wrapped in asterisks.
      const rendered = (card: CardElement) =>
        card.children.flatMap((child) =>
          child.type === 'text' ? [child.style === 'muted' ? `*${child.content}*` : child.content] : [],
        );
      const bridge = createChatSdkBridge({
        adapter: stubAdapter({ editMessage }),
        supportsThreads: false,
        cardFits: (card) => (card.title ?? '').length + rendered(card).join('\n').length <= 100,
      });
      // Title + text + resolution is exactly 100 unstyled; the asterisks push it over.
      const question = 'x'.repeat(100 - CARD_TITLE.length - 'Approved'.length - 1);
      await bridge.deliver('slack:D1', null, {
        kind: 'chat-sdk',
        content: {
          operation: 'edit',
          messageId: 'msg-1',
          terminalCard: { title: CARD_TITLE, question, resolution: 'Approved' },
        },
      });
      expect(editedTexts()).toEqual(['Approved']);
    });

    it('still removes the buttons when the resolution alone does not fit', async () => {
      const { editMessage, editedTexts } = editCapture();
      const bridge = createChatSdkBridge({
        adapter: stubAdapter({ editMessage }),
        supportsThreads: false,
        maxCardTextLength: 300,
      });
      await bridge.deliver('slack:D1', null, {
        kind: 'chat-sdk',
        content: {
          operation: 'edit',
          messageId: 'msg-1',
          terminalCard: { title: CARD_TITLE, question: 'x', resolution: 'r'.repeat(301) },
        },
      });
      expect(editedTexts()).toEqual(['Resolved.']);
    });
  });
});

describe('splitCardText', () => {
  const ampEscape = (t: string) => t.replace(/&/g, '&amp;');

  it('keeps text that fits as one block', () => {
    expect(splitCardText('Allow?', (t) => t, 100)).toEqual(['Allow?']);
  });

  it('measures each block after escaping and never cuts an escape in half', () => {
    const blocks = splitCardText('&'.repeat(100), ampEscape, 42);
    for (const block of blocks) {
      expect(block.length).toBeLessThanOrEqual(42);
      expect(block).toMatch(/^(&amp;)+$/);
    }
    expect(blocks.join('')).toBe(ampEscape('&'.repeat(100)));
  });

  it('splits at a line break when one is near the limit', () => {
    expect(splitCardText(`${'a'.repeat(30)}\n${'b'.repeat(30)}`, (t) => t, 40)).toEqual([
      `${'a'.repeat(30)}\n`,
      'b'.repeat(30),
    ]);
  });

  it('closes a code fence at the end of a block and reopens it in the next', () => {
    const text = 'Run:\n```\n' + 'y'.repeat(100) + '\n```';
    const blocks = splitCardText(text, (t) => t, 50);
    expect(blocks.length).toBeGreaterThan(1);
    for (const block of blocks) {
      expect(block.length).toBeLessThanOrEqual(50);
      expect((block.match(/```/g) ?? []).length % 2).toBe(0);
    }
    // Each split inside the fence adds a closing and a reopening fence.
    expect(blocks.join('').split('\n``````\n').join('')).toBe(text);
  });

  it('never cuts a fence marker in half', () => {
    expect(splitCardText('x'.repeat(48) + '```\ncode\n```', (t) => t, 50)).toEqual([
      'x'.repeat(47),
      'x```\ncode\n```\n```',
    ]);
  });

  it('never moves backticks from mid-line to the start of a block', () => {
    const text = '```\n' + 'x'.repeat(42) + '```[link](https://e.x)\n' + 'y'.repeat(30) + '\n```';
    const blocks = splitCardText(text, (t) => t, 50);
    expect(blocks.some((block) => /^```\[/m.test(block))).toBe(false);
    expect(blocks.join('').split('\n``````\n').join('')).toBe(text);
  });

  it('treats backticks inside a code line as text, not a fence', () => {
    const blocks = splitCardText(
      '```\nprintf "```"\n' + 'x'.repeat(1980) + '\n**delete everything**\n```',
      (t) => t,
      2000,
    );
    expect(blocks).toHaveLength(2);
    expect(blocks[0].endsWith('\n```')).toBe(true);
    expect(blocks[1].startsWith('```\n')).toBe(true);
  });

  it('rechecks the length after backing off a long fence marker', () => {
    const blocks = splitCardText('```\n' + 'x'.repeat(1992) + '\n````\n' + 'y'.repeat(10), (t) => t, 2000);
    for (const block of blocks) expect(block.length).toBeLessThanOrEqual(2000);
  });

  it('never splits a surrogate pair', () => {
    const blocks = splitCardText('😀'.repeat(50), (t) => t, 31);
    for (const block of blocks) {
      expect(block).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    }
    expect(blocks.join('')).toBe('😀'.repeat(50));
  });
});

describe('createChatSdkBridge.deliver — display cards (send_card)', () => {
  // The send_card MCP tool writes outbound rows with `{ type: 'card', card, fallbackText }`.
  // Before this branch existed the bridge silently dropped them: cards have no
  // `text` / `markdown`, so the trailing fallback `if (text)` was false and the
  // function returned without calling the adapter. These tests pin the contract
  // for the dedicated card branch.

  it('renders title, description, and string children, then posts via the adapter', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    const id = await bridge.deliver('telegram:42', null, {
      kind: 'chat-sdk',
      content: {
        type: 'card',
        card: {
          title: 'Daily',
          description: 'Your plate today',
          children: ['• item one', '• item two'],
        },
        fallbackText: 'Daily: your plate',
      },
    });
    expect(id).toBe('msg-stub');
    expect(calls).toHaveLength(1);
    const msg = calls[0].message as { card?: unknown; fallbackText?: string };
    expect(msg.fallbackText).toBe('Daily: your plate');
    expect(msg.card).toBeDefined();
  });

  it('drops actions without url (send_card is fire-and-forget; non-URL buttons would have nowhere to land)', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    await bridge.deliver('discord:guild:chan', null, {
      kind: 'chat-sdk',
      content: {
        type: 'card',
        card: {
          title: 'Card',
          description: 'has only label-only actions',
          actions: [{ label: 'Add' }, { label: 'Skip' }],
        },
      },
    });
    expect(calls).toHaveLength(1);
    // Cast through the public Card shape to read the children we set
    const msg = calls[0].message as { card?: { children?: Array<{ type?: string }> } };
    const childTypes = (msg.card?.children ?? []).map((c) => c.type);
    expect(childTypes).not.toContain('actions');
  });

  it('renders url actions as link buttons inside an Actions row', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    await bridge.deliver('discord:guild:chan', null, {
      kind: 'chat-sdk',
      content: {
        type: 'card',
        card: {
          title: 'Docs',
          actions: [{ label: 'Open', url: 'https://example.com' }, { label: 'No-link' }],
        },
      },
    });
    const msg = calls[0].message as {
      card?: { children?: Array<{ type?: string; children?: Array<{ type?: string; url?: string }> }> };
    };
    const actionsRow = msg.card?.children?.find((c) => c.type === 'actions');
    expect(actionsRow).toBeDefined();
    const buttons = actionsRow?.children ?? [];
    expect(buttons).toHaveLength(1);
    expect(buttons[0].type).toBe('link-button');
    expect(buttons[0].url).toBe('https://example.com');
  });

  it('survives a null action instead of throwing on a property read', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    await bridge.deliver('discord:guild:chan', null, {
      kind: 'chat-sdk',
      content: {
        type: 'card',
        card: {
          title: 'Docs',
          actions: [null, { label: 'Open', url: 'https://example.com' }],
        },
      },
    });
    const msg = calls[0].message as {
      card?: { children?: Array<{ type?: string; children?: Array<{ type?: string; url?: string }> }> };
    };
    const buttons = msg.card?.children?.find((c) => c.type === 'actions')?.children ?? [];
    expect(buttons).toHaveLength(1);
    expect(buttons[0].url).toBe('https://example.com');
  });

  it('renders an unknown style as the default button style rather than dropping the action', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    await bridge.deliver('discord:guild:chan', null, {
      kind: 'chat-sdk',
      content: {
        type: 'card',
        card: {
          title: 'Docs',
          actions: [
            { label: 'Open', url: 'https://example.com', style: 'chartreuse' },
            { label: 'Also', url: 'https://example.org', style: null },
          ],
        },
      },
    });
    const msg = calls[0].message as {
      card?: {
        children?: Array<{ type?: string; children?: Array<{ type?: string; url?: string; style?: string }> }>;
      };
    };
    const buttons = msg.card?.children?.find((c) => c.type === 'actions')?.children ?? [];
    expect(buttons).toHaveLength(2);
    expect(buttons[0].style).toBeUndefined();
    expect(buttons[1].style).toBeUndefined();
  });

  it('skips delivery when the card has neither title nor body content', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    const id = await bridge.deliver('telegram:42', null, {
      kind: 'chat-sdk',
      content: { type: 'card', card: {} },
    });
    expect(id).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('falls through to the text branch for non-card chat-sdk payloads (no regression)', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    await bridge.deliver('telegram:42', null, {
      kind: 'chat-sdk',
      content: { text: 'plain hello' },
    });
    expect(calls).toHaveLength(1);
    const msg = calls[0].message as { markdown?: string };
    expect(msg.markdown).toBe('plain hello');
  });
});

it('uses a registered approval presentation losslessly for initial and terminal cards', async () => {
  const { registerQuestionRenderResolver } = await import('./question-render-registry.js');
  const evidence = 'full evidence\n'.repeat(500);
  registerQuestionRenderResolver((id) =>
    id === 'presentation-fixture'
      ? {
          title: 'Review',
          options: [],
          deferResolution: true,
          renderMessage: () => ({ markdown: evidence }),
          renderTerminal: (resolution) => ({ markdown: `${evidence}\n${resolution}` }),
        }
      : undefined,
  );
  const { calls, postMessage } = makePostCapture();
  const edits: PostCall[] = [];
  const bridge = createChatSdkBridge({
    adapter: stubAdapter({
      postMessage,
      editMessage: async (threadId, _id, message) => {
        edits.push({ threadId, message });
        return { id: 'card', threadId, raw: {} };
      },
    }),
    supportsThreads: false,
  });
  await bridge.deliver('stub:C1', null, {
    kind: 'chat-sdk',
    content: {
      type: 'ask_question',
      questionId: 'presentation-fixture',
      title: 'Review',
      options: [],
      requirePresentation: true,
    },
  });
  expect(calls[0].message).toEqual({ markdown: evidence });
  await bridge.deliver('stub:C1', null, {
    kind: 'chat-sdk',
    content: {
      operation: 'edit',
      questionId: 'presentation-fixture',
      messageId: 'card',
      terminalCard: { resolution: 'Rejected' },
    },
  });
  expect(edits[0].message).toEqual({ markdown: `${evidence}\nRejected` });
});

it('forwards the authenticated instance and message address without editing a deferred approval', async () => {
  const { initTestDb, closeDb } = await import('../db/connection.js');
  const { runMigrations } = await import('../db/migrations/index.js');
  const { registerQuestionRenderResolver } = await import('./question-render-registry.js');
  await runMigrations(await initTestDb());
  registerQuestionRenderResolver((id) =>
    id === 'address-fixture'
      ? {
          title: 'Review',
          options: [{ label: 'Approve', selectedLabel: 'Approved', value: 'approve' }],
          deferResolution: true,
        }
      : undefined,
  );
  const editMessage = vi.fn();
  const adapter = stubAdapter({
    name: 'fixture',
    initialize: async () => {},
    channelIdFromThreadId: (threadId: string) => threadId,
    editMessage,
  });
  const bridge = createChatSdkBridge({ adapter, instance: 'fixture-one', supportsThreads: false });
  const onAction = vi.fn();
  try {
    await bridge.setup({ onInbound: () => {}, onInboundEvent: () => {}, onMetadata: () => {}, onAction });
    const chat = (bridge as unknown as { _chat: import('chat').Chat })._chat;
    await chat.processAction(
      {
        actionId: 'ncq:address-fixture:0',
        adapter,
        messageId: 'original-card',
        raw: {},
        threadId: 'fixture:room',
        user: { userId: 'selected' } as never,
        value: '0',
      },
      undefined,
    );
    expect(onAction).toHaveBeenCalledWith('address-fixture', 'approve', 'selected', {
      instance: 'fixture-one',
      messageId: 'original-card',
      platformId: 'fixture:room',
    });
    expect(editMessage).not.toHaveBeenCalled();
  } finally {
    await bridge.teardown();
    await closeDb();
  }
});

it('keeps a clicked card short when its request was posted above it', async () => {
  const { initTestDb, closeDb } = await import('../db/connection.js');
  const { runMigrations } = await import('../db/migrations/index.js');
  const { registerQuestionRenderResolver } = await import('./question-render-registry.js');
  await runMigrations(await initTestDb());
  registerQuestionRenderResolver((id) =>
    id === 'click-overflow'
      ? {
          title: 'Review',
          question: 'q'.repeat(1000),
          options: [{ label: 'Approve', selectedLabel: 'Approved', value: 'approve' }],
        }
      : undefined,
  );
  const editMessage = vi.fn();
  const adapter = stubAdapter({
    name: 'fixture',
    initialize: async () => {},
    channelIdFromThreadId: (threadId: string) => threadId,
    editMessage,
  });
  const bridge = createChatSdkBridge({
    adapter,
    instance: 'fixture-two',
    supportsThreads: false,
    cardFits: (card) =>
      (card.title ?? '').length +
        card.children.flatMap((child) => (child.type === 'text' ? [child.content] : [])).join('\n').length <=
      300,
  });
  try {
    await bridge.setup({ onInbound: () => {}, onInboundEvent: () => {}, onMetadata: () => {}, onAction: vi.fn() });
    const chat = (bridge as unknown as { _chat: import('chat').Chat })._chat;
    await chat.processAction(
      {
        actionId: 'ncq:click-overflow:0',
        adapter,
        messageId: 'button-card',
        raw: {},
        threadId: 'fixture:room',
        user: { userId: 'selected', userName: 'ann' } as never,
        value: '0',
      },
      undefined,
    );
    const edited = editMessage.mock.calls[0][2] as { card: { children: Array<{ content?: string }> } };
    expect(edited.card.children.map((child) => child.content)).toEqual([
      'Request ref click-overflow',
      'Approved by ann',
    ]);
  } finally {
    await bridge.teardown();
    await closeDb();
  }
});

describe('createChatSdkBridge — local Gateway webhook', () => {
  // The Gateway listener forwards raw events to a loopback server; only it may
  // post there. It sends the bot token in x-discord-gateway-token.
  const BOT_TOKEN = 'test-bot-token';
  const realFetch = globalThis.fetch;

  const click = JSON.stringify({
    type: 'GATEWAY_INTERACTION_CREATE',
    data: {
      type: 3,
      id: 'interaction-1',
      token: 'interaction-token',
      channel_id: 'chan-1',
      data: { custom_id: 'ncq:q-1:approve' },
      member: { user: { id: 'clicker-1', username: 'clicker' } },
      message: { id: 'card-1', embeds: [] },
    },
  });
  const message = JSON.stringify({ type: 'GATEWAY_MESSAGE_CREATE', data: { id: 'm-1', content: 'hi' } });

  async function startGateway(botToken?: string) {
    let webhookUrl = '';
    const handleWebhook = vi.fn(async () => new Response('ok'));
    const adapter = stubAdapter({
      name: 'discord',
      initialize: async () => {},
      handleWebhook,
      channelIdFromThreadId: (threadId: string) => threadId,
    }) as Adapter & { startGatewayListener: unknown };
    adapter.startGatewayListener = async (_opts: unknown, _ms: number, _signal: AbortSignal, url: string) => {
      webhookUrl = url;
      return new Response('{}');
    };
    const onAction = vi.fn();
    const bridge = createChatSdkBridge({ adapter, supportsThreads: true, botToken });
    await bridge.setup({ onInbound: () => {}, onInboundEvent: () => {}, onMetadata: () => {}, onAction });
    const post = (body: string, headers: Record<string, string> = {}) =>
      realFetch(webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
    return { bridge, post, onAction, handleWebhook, webhookUrl };
  }

  beforeEach(async () => {
    const { initTestDb } = await import('../db/connection.js');
    const { runMigrations } = await import('../db/migrations/index.js');
    await runMigrations(await initTestDb());
    // Interaction acks go to the Discord API; keep them off the network.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 204 })),
    );
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    const { closeDb } = await import('../db/connection.js');
    await closeDb();
  });

  it.each([
    ['no gateway token', {}],
    ['a wrong gateway token', { 'x-discord-gateway-token': 'not-the-token' }],
  ])('rejects a request with %s before it reaches the adapter or the host', async (_label, headers) => {
    const { bridge, post, onAction, handleWebhook } = await startGateway(BOT_TOKEN);
    try {
      for (const body of [click, message]) {
        const res = await post(body, headers);
        expect(res.status).toBe(401);
      }
      expect(onAction).not.toHaveBeenCalled();
      expect(handleWebhook).not.toHaveBeenCalled();
    } finally {
      await bridge.teardown();
    }
  });

  it('answers 401 without waiting for the request body', async () => {
    const { bridge, webhookUrl } = await startGateway(BOT_TOKEN);
    try {
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const req = http.request(webhookUrl, { method: 'POST', headers: { 'Content-Length': '1000' } }, (res) => {
          resolve(res.statusCode);
          req.destroy();
        });
        req.on('error', reject);
        req.flushHeaders(); // the body never follows
      });
      expect(status).toBe(401);
    } finally {
      await bridge.teardown();
    }
  });

  it('rejects every request when no bot token is configured', async () => {
    const { bridge, post, onAction, handleWebhook } = await startGateway(undefined);
    try {
      const res = await post(click, { 'x-discord-gateway-token': '' });
      expect(res.status).toBe(401);
      expect((await post(message)).status).toBe(401);
      expect(onAction).not.toHaveBeenCalled();
      expect(handleWebhook).not.toHaveBeenCalled();
    } finally {
      await bridge.teardown();
    }
  });

  it('dispatches clicks and forwards other events when the gateway token matches', async () => {
    const { bridge, post, onAction, handleWebhook } = await startGateway(BOT_TOKEN);
    try {
      const auth = { 'x-discord-gateway-token': BOT_TOKEN };
      expect((await post(click, auth)).status).toBe(200);
      expect(onAction).toHaveBeenCalledWith('q-1', 'approve', 'clicker-1', {
        messageId: 'card-1',
        platformId: 'chan-1',
      });
      expect((await post(message, auth)).status).toBe(200);
      expect(handleWebhook).toHaveBeenCalledTimes(1);
    } finally {
      await bridge.teardown();
    }
  });
});
