import { describe, expect, it } from 'vitest';
import { messagesToReturnAfterSend, STDIO_SERVER_INSTRUCTIONS, unreadMessagesBeforeSend } from '../src/tools.js';

describe('active-room presence contract', () => {
  it('does not treat quiet rooms or completed tasks as stop conditions', () => {
    expect(STDIO_SERVER_INSTRUCTIONS).toContain('task completion are never stop conditions');
    expect(STDIO_SERVER_INSTRUCTIONS).toContain('host explicitly tells you to leave');
  });
});

describe('room_send cursor recovery', () => {
  it('returns messages that arrived before the sender, but filters only its own message', () => {
    const messages = [
      { id: 8, client: 'web', name: 'robin', text: 'between sends' },
      { id: 9, client: 'cc', name: 'Codex', text: 'my message' },
      { id: 10, client: 'cc', name: 'Claude', text: 'also between sends' },
    ] as never[];

    expect(messagesToReturnAfterSend(messages, 'Codex', 9)).toEqual([
      messages[0],
      messages[2],
    ]);
  });

  it('fetches the unread batch from the pre-send cursor and returns it for the send response', async () => {
    const fetched = [
      { id: 20, client: 'web', name: 'robin', text: 'arrived before send' },
      { id: 21, client: 'cc', name: 'Codex', text: 'my message' },
    ] as never[];
    const calls: unknown[] = [];
    const client = {
      post: async (body: unknown) => {
        calls.push(body);
        return { messages: fetched, total: 22 };
      },
    } as never;

    await expect(unreadMessagesBeforeSend(client, 'ABC-DEF-GHJ', 'Codex', 21, 20)).resolves.toEqual([fetched[0]]);
    expect(calls).toEqual([{ action: 'messages', code: 'ABC-DEF-GHJ', cursor: 20 }]);
  });

  it('uses the retained history when the local cursor is missing instead of dropping messages', async () => {
    const fetched = [{ id: 30, client: 'web', name: 'robin', text: 'recover me' }] as never[];
    const client = {
      post: async (body: { cursor: number }) => {
        expect(body.cursor).toBe(0);
        return { messages: fetched, total: 31 };
      },
    } as never;

    await expect(unreadMessagesBeforeSend(client, 'ABC-DEF-GHJ', 'Codex', 31, undefined)).resolves.toEqual(fetched);
  });
});
