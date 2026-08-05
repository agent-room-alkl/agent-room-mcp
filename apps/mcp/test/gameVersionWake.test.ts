import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runRoomListenPoll } from '../src/tools.js';
import type { RoomApiClient } from '../src/roomApi.js';

// Zero new messages but a bumped room.gameVersion (a vote/deal changed
// private game state) must still make room_listen return immediately,
// carrying the new gameVersion — otherwise an MCP-connected agent sits in
// its poll loop unaware its hand or the game phase changed.

async function makeStateFile() {
  const dir = await fs.mkdtemp(join(tmpdir(), 'agent-room-gv-'));
  return join(dir, 'state.json');
}

function fakeClient(room: Record<string, unknown>): RoomApiClient {
  return {
    async post<T>(payload: Record<string, unknown>): Promise<T> {
      switch (payload.action) {
        case 'get':
        case 'sweep':
          return { room } as T;
        case 'messages':
          return { messages: [], total: 0 } as T;
        case 'presence':
          return {} as T;
        default:
          throw new Error(`fakeClient: unhandled action ${String(payload.action)}`);
      }
    },
  };
}

beforeEach(async () => {
  vi.stubEnv('AGENT_ROOM_STATE_FILE', await makeStateFile());
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('room_listen wakes on gameVersion change (T-15)', () => {
  it('returns immediately with the new gameVersion when zero messages arrived but gameVersion bumped', async () => {
    const room = {
      status: 'active',
      createdBy: 'robin',
      replyMode: 'game',
      participants: [{ name: 'Claude', client: 'cc' }],
      gameVersion: 7,
    };
    const client = fakeClient(room);

    const start = Date.now();
    const result = await runRoomListenPoll(client, 'ABC-DEF-GHJ', 0, 3000, 'Claude');
    const elapsed = Date.now() - start;

    expect(result.messages).toEqual([]);
    expect(result.gameVersion).toBe(7);
    expect(elapsed).toBeLessThan(1500); // did not sit through the ~2s quiet-tick sleep
  });

  it('includes gameVersion on the room_ended termination path', async () => {
    const room = {
      status: 'ended',
      createdBy: 'robin',
      replyMode: 'game',
      participants: [{ name: 'Claude', client: 'cc' }],
      gameVersion: 12,
    };
    const client = fakeClient(room);

    const result = await runRoomListenPoll(client, 'ABC-DEF-GHJ', 0, 3000, 'Claude');

    expect(result.terminated).toBe('room_ended');
    expect(result.gameVersion).toBe(12);
  });

  it('includes gameVersion on the kicked termination path', async () => {
    const room = {
      status: 'active',
      createdBy: 'robin',
      replyMode: 'game',
      participants: [{ name: 'SomeoneElse', client: 'cc' }], // "Claude" is no longer listed
      gameVersion: 3,
    };
    const client = fakeClient(room);

    const result = await runRoomListenPoll(client, 'ABC-DEF-GHJ', 0, 3000, 'Claude');

    expect(result.terminated).toBe('kicked');
    expect(result.gameVersion).toBe(3);
  });
});
