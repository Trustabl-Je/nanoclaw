/**
 * Response handler registry.
 *
 * Extracted from index.ts so that modules calling `registerResponseHandler()`
 * at import time don't hit a TDZ error on the const-array declaration.
 * index.ts imports src/modules/index.js for its side effects, which triggers
 * module registrations that would otherwise happen before index.ts's own
 * const initializers have run.
 *
 * Keep this file dependency-free (log.js is fine, but nothing from
 * modules/* or index.ts itself). Any file imported here must not in turn
 * import from src/index.ts, or the cycle returns.
 */

import { log } from './log.js';

export interface ResponsePayload {
  questionId: string;
  instance?: string;
  messageId?: string;
  value: string;
  userId: string | null;
  channelType: string;
  platformId: string;
  threadId: string | null;
  /** Set by dispatchResponse: a handler with slow work after its decision calls it once the decision is recorded. */
  accepted?: () => void;
}

/**
 * What a click did. A card shows a resolution only for 'accepted'. 'refused':
 * the clicker may not answer it, so it keeps its buttons. 'closed': the request
 * is gone (its session, event or target vanished), so the card says it is no
 * longer available. 'ignored': nothing was decided (already resolved, expired,
 * not ours).
 */
export type ResponseOutcome = 'accepted' | 'refused' | 'closed' | 'ignored';

/** Returns the click's outcome when the handler owns it, else false to pass it on. */
export type ResponseHandler = (payload: ResponsePayload) => Promise<ResponseOutcome | false>;

const responseHandlers: ResponseHandler[] = [];

export function registerResponseHandler(handler: ResponseHandler, options: { prepend?: boolean } = {}): void {
  if (options.prepend) responseHandlers.unshift(handler);
  else responseHandlers.push(handler);
}

export function getResponseHandlers(): readonly ResponseHandler[] {
  return responseHandlers;
}

/**
 * Offers a click to each handler in turn until one owns it. Resolves with its
 * outcome as soon as that is known (an early `accepted()` call or the
 * handler's return); an unowned or failed click is 'ignored'.
 */
export function dispatchResponse(payload: ResponsePayload): Promise<ResponseOutcome> {
  return new Promise((resolve) => {
    void (async () => {
      const owned = { ...payload, accepted: () => resolve('accepted') };
      for (const handler of responseHandlers) {
        try {
          const outcome = await handler(owned);
          if (outcome) return resolve(outcome);
        } catch (err) {
          log.error('Response handler threw', { questionId: payload.questionId, err });
        }
      }
      log.warn('Unclaimed response', { questionId: payload.questionId, value: payload.value });
      resolve('ignored');
    })();
  });
}
