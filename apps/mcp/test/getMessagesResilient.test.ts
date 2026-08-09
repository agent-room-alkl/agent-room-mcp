import { describe, expect, it, vi } from 'vitest';
import { getMessagesResilient } from '../src/getMessagesResilient.js';
import type { RoomApiClient } from '../src/roomApi.js';
import type { Message } from '@agent-room/shared';

const fakeClient = {} as RoomApiClient;

describe('getMessagesResilient', () => {
  it('returns messages when fetchFn succeeds', async () => {
    const msgs = [{ id: 1, text: 'hi' } as Message];
    const fetchFn = vi.fn(async () => ({ messages: msgs, total: 1 }));
    const result = await getMessagesResilient(fetchFn, fakeClient, 'AAA-BBB-CCC', 0);
    expect(result).toEqual({ ok: true, result: { messages: msgs, total: 1 } });
    expect(fetchFn).toHaveBeenCalledWith(fakeClient, 'AAA-BBB-CCC', 0);
  });

  it('does not throw when fetchFn fails — listen poll can continue', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('ECONNRESET simulated');
    });
    const result = await getMessagesResilient(fetchFn, fakeClient, 'AAA-BBB-CCC', 3);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(Error);
      expect((result.error as Error).message).toContain('ECONNRESET');
    }
  });

  it('injected failure then success does not abort the chain', async () => {
    const msgs = [{ id: 2, text: 'recovered' } as Message];
    const fetchFn = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient 503'))
      .mockResolvedValueOnce({ messages: msgs, total: 2 });

    const first = await getMessagesResilient(fetchFn, fakeClient, 'AAA-BBB-CCC', 0);
    expect(first.ok).toBe(false);

    const second = await getMessagesResilient(fetchFn, fakeClient, 'AAA-BBB-CCC', 0);
    expect(second).toEqual({ ok: true, result: { messages: msgs, total: 2 } });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});
