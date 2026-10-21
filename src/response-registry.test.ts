import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ResponsePayload } from './response-registry.js';

const click: ResponsePayload = {
  questionId: 'q-1',
  value: 'approve',
  userId: 'clicker',
  channelType: 'slack',
  platformId: 'C1',
  threadId: null,
};

// The registry is module state: each test gets a fresh copy.
async function freshRegistry() {
  vi.resetModules();
  return import('./response-registry.js');
}

describe('dispatchResponse', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns the owning handler's outcome and stops there", async () => {
    const { dispatchResponse, registerResponseHandler } = await freshRegistry();
    const later = vi.fn(async () => 'accepted' as const);
    registerResponseHandler(async () => false);
    registerResponseHandler(async () => 'refused');
    registerResponseHandler(later);

    expect(await dispatchResponse(click)).toBe('refused');
    expect(later).not.toHaveBeenCalled();
  });

  it('reports an early acceptance before the handler finishes its slow work', async () => {
    const { dispatchResponse, registerResponseHandler } = await freshRegistry();
    let finish!: () => void;
    const slowWork = new Promise<void>((resolve) => (finish = resolve));
    let done = false;
    registerResponseHandler(async (payload) => {
      payload.accepted?.();
      await slowWork;
      done = true;
      return 'accepted';
    });

    expect(await dispatchResponse(click)).toBe('accepted');
    expect(done).toBe(false);
    finish();
  });

  it('treats an unowned or failed click as ignored', async () => {
    const { dispatchResponse, registerResponseHandler } = await freshRegistry();
    expect(await dispatchResponse(click)).toBe('ignored');

    registerResponseHandler(async () => {
      throw new Error('boom');
    });
    expect(await dispatchResponse(click)).toBe('ignored');
  });
});
