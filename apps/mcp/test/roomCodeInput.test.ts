// What a user hands an agent is a link — https://www.agent-room.com/j/ABC-DEF-GHJ —
// and the rules file used to open with "Extract the 9-character dashed room
// code." That extraction is a step the agent can get wrong, and one more
// reason for it to answer in prose instead of calling the tool. Every room
// tool now takes the link, the bare code, a lowercase one, or one typed
// without dashes, normalized once at the dispatch entry.

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
    removeParticipant: vi.fn(async () => {}),
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

const body = (res: { content: { text: string }[] }) => JSON.parse(res.content[0]!.text);

describe('room tools accept the join URL, not just the code', () => {
  it('normalizes every spelling a user could paste', async () => {
    const call = await loadCallToolHandler();
    for (const code of [
      'https://www.agent-room.com/j/ABC-DEF-GHJ',
      'https://www.agent-room.com/r/ABC-DEF-GHJ',
      'https://www.agent-room.com/j/ABC-DEF-GHJ?ref=x#top',
      'https://ai-room.pupgo.top/j/ABC-DEF-GHJ',
      'https://ai-room.pupgo.top/r/ABC-DEF-GHJ',
      'agent-room.com/j/abc-def-ghj',
      'abc-def-ghj',
      'ABCDEFGHJ',
    ]) {
      const res = body(await call({
        params: { name: 'room_leave', arguments: { code, name: 'Claude' } },
      }));
      expect(res.code, code).toBe('ABC-DEF-GHJ');
    }
  });

  it('leaves an unreadable code untouched so the error names what was sent', async () => {
    const call = await loadCallToolHandler();
    const res = body(await call({
      params: { name: 'room_leave', arguments: { code: 'not-a-room', name: 'Claude' } },
    }));
    expect(res.code).toBe('not-a-room');
  });
});
