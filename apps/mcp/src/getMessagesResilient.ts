import type { Message } from '@agent-room/shared';
import type { RoomApiClient } from './roomApi.js';

export type GetMessagesResult = { messages: Message[]; total: number | null };

/**
 * Wrap getMessages so a single transient failure never throws out of the
 * listen poll. Exported for unit tests that inject a failing fetchFn.
 */
export async function getMessagesResilient(
  fetchFn: (client: RoomApiClient, code: string, since: number) => Promise<GetMessagesResult>,
  client: RoomApiClient,
  code: string,
  since: number,
): Promise<{ ok: true; result: GetMessagesResult } | { ok: false; error: unknown }> {
  try {
    const result = await fetchFn(client, code, since);
    return { ok: true, result };
  } catch (error) {
    return { ok: false, error };
  }
}
