// Room 4YG-B23-W73: Antigravity's room_send was rejected with
// error="muted", telling it "the host needs to unmute you" — but nobody had
// muted anything. The server's speaker gate used to collapse two different
// situations into one MutedError: (name, client) never joined the room at
// all, and a real participant the host actually silenced. Here Antigravity's
// own identity state had drifted and it sent under the literal string
// "undefined" instead of its real joined name, so there was nothing to
// unmute — the room was stuck, since waiting for a mute that was never set
// can never resolve.
//
// The server (agent-room-commercial) now throws NotParticipantError for the
// never-joined case and reserves MutedError for a genuinely muted
// participant. This pins that this package's error mapping and room_send /
// room_status catch blocks recognize NotParticipantError distinctly and
// point the caller at room_join — not at a host who was never involved.

import { describe, expect, it, vi } from 'vitest';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

vi.mock('../src/state.js', () => ({
  setRoom: vi.fn(async () => {}),
  removeRoom: vi.fn(async () => {}),
  updateCursor: vi.fn(async () => {}),
  updateGameVersion: vi.fn(async () => {}),
  markSent: vi.fn(async () => {}),
  readState: vi.fn(async () => ({ version: 1, rooms: {} })),
  readRoomStateForJoin: vi.fn(async () => undefined),
}));

vi.mock('../src/roomApi.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/roomApi.js')>();
  return {
    ...actual,
    createRoomApiClient: () => ({ post: vi.fn(async () => ({})) }),
    getRoom: vi.fn(async () => ({ code: 'ABC-DEF-GHJ', participants: [] })),
    appendMessage: vi.fn(async (_client: unknown, _code: string, message: { name: string }) => {
      throw new actual.NotParticipantError(
        `"${message.name}" is not a participant of this room — join it before sending messages.`,
      );
    }),
  };
});

type Handler = (req: unknown) => Promise<{ content: { type: string; text: string }[] }>;

async function loadCallToolHandler(): Promise<Handler> {
  const { registerTools } = await import('../src/tools.js');
  const handlers = new Map<unknown, Handler>();
  const server = {
    setRequestHandler(schema: unknown, handler: Handler) {
      handlers.set(schema, handler);
    },
    sendLoggingMessage: async () => {},
  } as unknown as Server;
  registerTools(server);
  return handlers.get(CallToolRequestSchema)!;
}

describe('room_send / room_status — never-joined sender', () => {
  it('room_send reports not_participant, not muted, and points at room_join', async () => {
    const callTool = await loadCallToolHandler();
    const res = await callTool({
      params: { name: 'room_send', arguments: { code: 'ABC-DEF-GHJ', name: 'undefined', text: 'hi' } },
    });
    const body = JSON.parse(res.content[0].text);

    expect(body.sent).toBe(false);
    expect(body.error).toBe('not_participant');
    expect(body.error).not.toBe('muted');
    expect(body.hint).toMatch(/room_join/);
    expect(body.hint).not.toMatch(/unmute/i);
  });

  it('room_status (the status-ping alias) gets the same treatment', async () => {
    const callTool = await loadCallToolHandler();
    const res = await callTool({
      params: { name: 'room_status', arguments: { code: 'ABC-DEF-GHJ', name: 'undefined', text: 'still here' } },
    });
    const body = JSON.parse(res.content[0].text);

    expect(body.sent).toBe(false);
    expect(body.error).toBe('not_participant');
    expect(body.hint).toMatch(/room_join/);
  });
});
