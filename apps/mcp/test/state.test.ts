import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mergeStates, type AgentRoomState } from '../src/state.js';

async function makeStateDir(prefix: string) {
  return fs.mkdtemp(join(tmpdir(), prefix));
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('mergeStates', () => {
  it('keeps the highest cursor for rooms found in multiple PPID state files', () => {
    const older: AgentRoomState = {
      version: 1,
      blockStreak: 2,
      rooms: {
        'GBX-YXT-C3R': {
          name: 'Cursor',
          cursor: 10,
          joinedAt: 100,
        },
      },
    };
    const newer: AgentRoomState = {
      version: 1,
      blockStreak: 5,
      rooms: {
        'GBX-YXT-C3R': {
          name: 'Cursor',
          cursor: 14,
          joinedAt: 200,
          lastSentAt: 300,
        },
      },
    };

    expect(mergeStates([older, newer])).toEqual({
      version: 1,
      blockStreak: 5,
      rooms: {
        'GBX-YXT-C3R': {
          name: 'Cursor',
          cursor: 14,
          joinedAt: 200,
          lastSentAt: 300,
        },
      },
    });
  });

  it('preserves separate rooms while merging block streaks', () => {
    const first: AgentRoomState = {
      version: 1,
      blockStreak: 1,
      rooms: {
        'AAA-BBB-CCC': { name: 'Cursor', cursor: 2, joinedAt: 100 },
      },
    };
    const second: AgentRoomState = {
      version: 1,
      blockStreak: 3,
      rooms: {
        'DDD-EEE-FFF': { name: 'Cursor', cursor: 7, joinedAt: 200 },
      },
    };

    expect(mergeStates([first, second])).toEqual({
      version: 1,
      blockStreak: 3,
      rooms: {
        'AAA-BBB-CCC': { name: 'Cursor', cursor: 2, joinedAt: 100 },
        'DDD-EEE-FFF': { name: 'Cursor', cursor: 7, joinedAt: 200 },
      },
    });
  });
});

describe('state harness files', () => {
  beforeEach(() => {
    // detectHarness matches Claude Code's env vars before CODEX_RUN_ID —
    // clear them so the tests pass when the suite runs inside Claude Code.
    vi.stubEnv('CLAUDECODE', '');
    vi.stubEnv('CLAUDE_CODE_ENTRYPOINT', '');
  });

  it('writes thread-scoped Codex harness state alongside the PPID-scoped state', async () => {
    const dir = await makeStateDir('agent-room-state-codex-');
    vi.stubEnv('AGENT_ROOM_STATE_DIR', dir);
    vi.stubEnv('CODEX_RUN_ID', 'test-run');

    const { setRoom } = await import('../src/state.js');
    await setRoom('ABC-DEF-GHJ', {
      name: 'Codex',
      cursor: 2,
      joinedAt: 123,
    });

    const files = await fs.readdir(dir);
    expect(files).toContain('state-harness-codex-test-run.json');

    const harnessRaw = await fs.readFile(join(dir, 'state-harness-codex-test-run.json'), 'utf8');
    expect(JSON.parse(harnessRaw).rooms['ABC-DEF-GHJ']).toMatchObject({
      name: 'Codex',
      cursor: 2,
    });
  });

  it('does not write a shared Codex harness file when no run id is exposed', async () => {
    const dir = await makeStateDir('agent-room-state-codex-anonymous-');
    vi.stubEnv('AGENT_ROOM_STATE_DIR', dir);
    vi.stubEnv('CODEX_RUN_ID', '');
    vi.stubEnv('AGENT_ROOM_RUN_ID', '');

    const { setRoom } = await import('../src/state.js');
    await setRoom('ABC-DEF-GHJ', { name: 'Codex', cursor: 2, joinedAt: 123 });

    expect((await fs.readdir(dir)).some((name) => name === 'state-harness-codex.json')).toBe(false);
  });

  it('reads thread-scoped Codex harness state when the hook PPID state is empty', async () => {
    const dir = await makeStateDir('agent-room-state-codex-read-');
    vi.stubEnv('AGENT_ROOM_STATE_DIR', dir);
    vi.stubEnv('CODEX_RUN_ID', 'test-run');

    await fs.writeFile(
      join(dir, 'state-harness-codex-test-run.json'),
      JSON.stringify({
        version: 1,
        blockStreak: 0,
        rooms: {
          'ABC-DEF-GHJ': {
            name: 'Codex',
            cursor: 7,
            joinedAt: 456,
          },
        },
      }),
      'utf8'
    );

    const { readHarnessStateOrMerged } = await import('../src/state.js');
    const state = await readHarnessStateOrMerged();
    expect(state.rooms['ABC-DEF-GHJ']).toMatchObject({
      name: 'Codex',
      cursor: 7,
    });
  });

  it('finds a same-name prior room state after the PPID state changes', async () => {
    const dir = await makeStateDir('agent-room-state-rejoin-');
    vi.stubEnv('AGENT_ROOM_STATE_DIR', dir);

    await fs.writeFile(
      join(dir, 'state-111.json'),
      JSON.stringify({
        version: 1,
        blockStreak: 0,
        rooms: {
          'ABC-DEF-GHJ': {
            name: 'Claude',
            cursor: 7,
            joinedAt: 456,
          },
        },
      }),
      'utf8'
    );
    await fs.writeFile(
      join(dir, 'state-222.json'),
      JSON.stringify({
        version: 1,
        blockStreak: 0,
        rooms: {
          'ABC-DEF-GHJ': {
            name: 'Codex',
            cursor: 12,
            joinedAt: 789,
          },
        },
      }),
      'utf8'
    );

    const { readRoomStateForJoin } = await import('../src/state.js');
    const state = await readRoomStateForJoin('ABC-DEF-GHJ', 'Claude');
    expect(state).toMatchObject({
      name: 'Claude',
      cursor: 7,
    });
  });
});

describe('state lock', () => {
  it('serializes concurrent updateCursor calls (no lost updates)', async () => {
    const dir = await makeStateDir('agent-room-state-lock-');
    vi.stubEnv('AGENT_ROOM_STATE_DIR', dir);
    vi.stubEnv('CLAUDECODE', '');
    vi.stubEnv('CLAUDE_CODE_ENTRYPOINT', '');

    const { setRoom, updateCursor, readMergedState } = await import('../src/state.js');
    await setRoom('AAA-BBB-CCC', { name: 'X', cursor: 0, joinedAt: 1 });

    // Without the cross-process lock these all read cursor=0 concurrently and
    // the last writer wins with an arbitrary value; with it they serialize and
    // the monotonic guard lands on the maximum.
    await Promise.all(Array.from({ length: 20 }, (_, i) => updateCursor('AAA-BBB-CCC', i + 1)));

    const state = await readMergedState();
    expect(state.rooms['AAA-BBB-CCC']?.cursor).toBe(20);
  });

  // POSIX permission bits are not meaningful on Windows (chmod is a no-op
  // there and stat reports 0666), so the mode assertion is POSIX-only.
  it.skipIf(process.platform === 'win32')('writes state files with 0600 permissions', async () => {
    const dir = await makeStateDir('agent-room-state-mode-');
    vi.stubEnv('AGENT_ROOM_STATE_DIR', dir);
    vi.stubEnv('CLAUDECODE', '');
    vi.stubEnv('CLAUDE_CODE_ENTRYPOINT', '');

    const { setRoom } = await import('../src/state.js');
    await setRoom('AAA-BBB-CCC', { name: 'X', cursor: 0, joinedAt: 1, hostKey: 'secret' });

    const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const st = await fs.stat(join(dir, f));
      // eslint-disable-next-line no-bitwise
      expect(st.mode & 0o777).toBe(0o600);
    }
  });
});

describe('mergeStates — cross-client ownership', () => {
  const room = (over: Partial<import('../src/state.js').RoomState>) => ({
    name: 'X',
    cursor: 1,
    joinedAt: 1,
    ...over,
  });

  // Observed 2026-08-05: Antigravity joined AV6-B7T-R6S, then Claude Desktop
  // joined the same room 118s later. mergeStates kept only the newest record's
  // clientKind, so the shared merged record flipped to 'unknown' and
  // Antigravity's own room stopped matching its own clientKind check. Whoever
  // joins last must not take ownership of everyone else's room record.
  it('prefers the record matching the reading harness over the most recent one', async () => {
    vi.stubEnv('CLAUDECODE', '');
    vi.stubEnv('CLAUDE_CODE_ENTRYPOINT', '');
    vi.stubEnv('CODEX_RUN_ID', 'reader-thread'); // reading harness is 'codex'
    const { mergeStates: merge } = await import('../src/state.js');

    const mine: AgentRoomState = {
      version: 1,
      rooms: { 'AV6-B7T-R6S': room({ clientKind: 'codex', joinedAt: 100 }) },
    };
    const theirsButNewer: AgentRoomState = {
      version: 1,
      rooms: { 'AV6-B7T-R6S': room({ clientKind: 'antigravity', joinedAt: 999 }) },
    };

    expect(merge([mine, theirsButNewer]).rooms['AV6-B7T-R6S']?.clientKind).toBe('codex');
    // Order of state files on disk must not change the outcome.
    expect(merge([theirsButNewer, mine]).rooms['AV6-B7T-R6S']?.clientKind).toBe('codex');
  });

  it('never grafts the losing record\'s owner identity onto the winner', async () => {
    vi.stubEnv('CLAUDECODE', '');
    vi.stubEnv('CLAUDE_CODE_ENTRYPOINT', '');
    vi.stubEnv('CODEX_RUN_ID', 'reader-thread');
    const { mergeStates: merge } = await import('../src/state.js');

    const winner: AgentRoomState = {
      version: 1,
      rooms: { 'AV6-B7T-R6S': room({ clientKind: 'codex', joinedAt: 100, cursor: 5 }) },
    };
    const loser: AgentRoomState = {
      version: 1,
      rooms: {
        'AV6-B7T-R6S': room({
          clientKind: 'antigravity',
          joinedAt: 999,
          cursor: 9,
          sessionKey: 'their-session',
          ownerRunId: 'their-thread',
        }),
      },
    };

    const merged = merge([winner, loser]).rooms['AV6-B7T-R6S'];
    // `winner.x ?? loser.x` would hand the winner an owner it never had.
    expect(merged?.sessionKey).toBeUndefined();
    expect(merged?.ownerRunId).toBeUndefined();
    // Cursor is still maxed — it only guards against replaying messages.
    expect(merged?.cursor).toBe(9);
  });

  it('falls back to recency when both records match the reading harness', async () => {
    vi.stubEnv('CLAUDECODE', '');
    vi.stubEnv('CLAUDE_CODE_ENTRYPOINT', '');
    vi.stubEnv('CODEX_RUN_ID', 'reader-thread');
    const { mergeStates: merge } = await import('../src/state.js');

    const older: AgentRoomState = {
      version: 1,
      rooms: { 'AV6-B7T-R6S': room({ clientKind: 'codex', joinedAt: 100, name: 'old' }) },
    };
    const newer: AgentRoomState = {
      version: 1,
      rooms: { 'AV6-B7T-R6S': room({ clientKind: 'codex', joinedAt: 999, name: 'new' }) },
    };

    expect(merge([older, newer]).rooms['AV6-B7T-R6S']?.name).toBe('new');
  });
});

describe('readHarnessStateOrMerged — harness scope must not read other clients', () => {
  // The Codex/Cursor stop hook reads harness scope. The old `rooms.length > 0`
  // guard fell through to readMergedState() whenever the harness file listed no
  // rooms — i.e. on every Stop of every Codex thread not in a room — and that
  // read EVERY client's state file, before clientKind could filter anything.
  it('returns the empty thread-scoped harness state instead of falling back to merged', async () => {
    const dir = await makeStateDir('agent-room-harness-scope-');
    vi.stubEnv('AGENT_ROOM_STATE_DIR', dir);
    vi.stubEnv('CLAUDECODE', '');
    vi.stubEnv('CLAUDE_CODE_ENTRYPOINT', '');
    vi.stubEnv('CODEX_RUN_ID', 'reader-thread'); // harness file = state-harness-codex-reader-thread.json

    // Another client (Antigravity) is in a room and wrote its own PPID file.
    await fs.writeFile(
      join(dir, 'state-99999.json'),
      JSON.stringify({
        version: 1,
        rooms: { 'AV6-B7T-R6S': { name: 'Antigravity', cursor: 1, joinedAt: 1, clientKind: 'antigravity' } },
      }),
    );
    // This harness has an empty harness file: it is in no room.
    await fs.writeFile(
      join(dir, 'state-harness-codex-reader-thread.json'),
      JSON.stringify({ version: 1, rooms: {}, blockStreak: 0 }),
    );

    const { readHarnessStateOrMerged } = await import('../src/state.js');
    expect(Object.keys((await readHarnessStateOrMerged()).rooms)).toEqual([]);
  });

  it('does not fall back to a legacy shared harness file for a thread-scoped reader', async () => {
    const dir = await makeStateDir('agent-room-harness-legacy-');
    vi.stubEnv('AGENT_ROOM_STATE_DIR', dir);
    vi.stubEnv('CLAUDECODE', '');
    vi.stubEnv('CLAUDE_CODE_ENTRYPOINT', '');
    vi.stubEnv('CODEX_RUN_ID', 'reader-thread');

    await fs.writeFile(
      join(dir, 'state-harness-codex.json'),
      JSON.stringify({
        version: 1,
        rooms: { 'AV6-B7T-R6S': { name: 'Legacy', cursor: 1, joinedAt: 1 } },
      }),
    );

    const { readHarnessStateOrMerged } = await import('../src/state.js');
    expect(Object.keys((await readHarnessStateOrMerged()).rooms)).toEqual([]);
  });

  it('keeps concurrent Codex threads in separate harness state files', async () => {
    const dir = await makeStateDir('agent-room-harness-isolation-');
    vi.stubEnv('AGENT_ROOM_STATE_DIR', dir);
    vi.stubEnv('CODEX_RUN_ID', 'room-a-thread');

    await fs.writeFile(join(dir, 'state-harness-codex-room-a-thread.json'), JSON.stringify({
      version: 1,
      rooms: { 'AAA-BBB-CCC': { name: 'Room A', cursor: 1, joinedAt: 1, clientKind: 'codex', ownerRunId: 'room-a-thread' } },
    }));

    vi.stubEnv('CODEX_RUN_ID', 'room-b-thread');
    vi.resetModules();
    await fs.writeFile(join(dir, 'state-harness-codex-room-b-thread.json'), JSON.stringify({
      version: 1,
      rooms: { 'DDD-EEE-FFF': { name: 'Room B', cursor: 1, joinedAt: 2, clientKind: 'codex', ownerRunId: 'room-b-thread' } },
    }));
    const { readHarnessStateOrMerged: readB } = await import('../src/state.js');

    expect(Object.keys((await readB()).rooms)).toEqual(['DDD-EEE-FFF']);
    expect(await fs.readFile(join(dir, 'state-harness-codex-room-a-thread.json'), 'utf8')).toContain('AAA-BBB-CCC');
    expect(await fs.readFile(join(dir, 'state-harness-codex-room-b-thread.json'), 'utf8')).toContain('DDD-EEE-FFF');
  });
});

describe('claimRoomSessionEverywhere — stamps only the caller\'s own records', () => {
  it('leaves another client\'s record for the same room untouched', async () => {
    const dir = await makeStateDir('agent-room-claim-');
    vi.stubEnv('AGENT_ROOM_STATE_DIR', dir);
    vi.stubEnv('CLAUDECODE', '');
    vi.stubEnv('CLAUDE_CODE_ENTRYPOINT', '');
    vi.stubEnv('CODEX_RUN_ID', 'my-thread');

    const foreign = join(dir, 'state-99999.json');
    await fs.writeFile(
      foreign,
      JSON.stringify({
        version: 1,
        rooms: { 'AV6-B7T-R6S': { name: 'Antigravity', cursor: 1, joinedAt: 1, clientKind: 'antigravity' } },
      }),
    );

    const { setRoom, claimRoomSessionEverywhere } = await import('../src/state.js');
    await setRoom('AV6-B7T-R6S', { name: 'Me', cursor: 1, joinedAt: 2, clientKind: 'codex', ownerRunId: 'my-thread' });

    expect(await claimRoomSessionEverywhere('AV6-B7T-R6S', 'my-session')).toBe(true);

    // Pre-0.26.10 this wrote 'my-session' into Antigravity's record too — which
    // is how two different agents ended up sharing one sessionKey.
    const after = JSON.parse(await fs.readFile(foreign, 'utf8'));
    expect(after.rooms['AV6-B7T-R6S'].sessionKey).toBeUndefined();
  });
});
