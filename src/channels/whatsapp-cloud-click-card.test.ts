/**
 * A WhatsApp Cloud button reply arrives as its own message, so its id is not
 * the card's: the bridge must name no card to the host for these clicks.
 */
import { describe, expect, it, vi } from 'vitest';

const captured = vi.hoisted(() => ({ config: undefined as Record<string, unknown> | undefined }));

vi.mock('../env.js', () => ({
  readEnvFile: () => ({
    WHATSAPP_ACCESS_TOKEN: 'test-access-token',
    WHATSAPP_PHONE_NUMBER_ID: 'test-phone-number-id',
    WHATSAPP_APP_SECRET: 'test-app-secret',
    WHATSAPP_VERIFY_TOKEN: 'test-verify-token',
  }),
}));
vi.mock('./chat-sdk-bridge.js', () => ({
  createChatSdkBridge: (config: Record<string, unknown>) => {
    captured.config = config;
    return { instance: 'whatsapp-cloud', channelType: 'whatsapp' };
  },
}));

import { whatsappCloudRegistration } from './whatsapp-cloud.js';

describe('whatsapp-cloud clicks', () => {
  it('tells the bridge a click is not the card message', async () => {
    await whatsappCloudRegistration.factory();
    expect(captured.config?.actionMessageIsCard).toBe(false);
  });
});
