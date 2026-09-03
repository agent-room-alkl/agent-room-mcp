import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyHookInput, resolveHookSessionKey } from '../src/hook.js';
import { roomBelongsToSession } from '../src/state.js';

describe('classifyHookInput', () => {
  it('detects Cursor stop payloads without hook_event_name', () => {
    expect(classifyHookInput({ status: 'completed', loop_count: 0 })).toEqual({
      event: 'Stop',
      cursorMode: true,
    });
  });

  it('detects current Cursor stop payloads that include hook_event_name', () => {
    expect(classifyHookInput({
      hook_event_name: 'stop',
      status: 'completed',
      loop_count: 0,
    })).toEqual({
      event: 'Stop',
      cursorMode: true,
    });
  });

  it('normalizes lowercase stop for non-Cursor hook payloads', () => {
    expect(classifyHookInput({ hook_event_name: 'stop' })).toEqual({
      event: 'Stop',
      cursorMode: false,
    });
  });

  it('ignores empty hook payloads', () => {
    expect(classifyHookInput({})).toBeNull();
  });
});

describe('resolveHookSessionKey', () => {
  it('prefers Codex session_id over Cursor conversation_id', () => {
    expect(resolveHookSessionKey({
      session_id: 'codex-sess',
      conversation_id: 'cursor-conv',
    })).toBe('codex-sess');
  });

  it('falls back to Cursor conversation_id', () => {
    expect(resolveHookSessionKey({ conversation_id: ' cursor-conv ' })).toBe('cursor-conv');
  });

  it('returns undefined when neither is present', () => {
    expect(resolveHookSessionKey({})).toBeUndefined();
  });
});

describe('Stop continuation safety fuse', () => {
  it('blocks N times, allows N+1 with a reason, and resets the streak', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'agent-room-hook-budget-'));
    const stateFile = join(dir, 'state.json');
    await fs.writeFile(stateFile, JSON.stringify({ version: 1, rooms: {}, blockStreak: 0 }));

    vi.resetModules();
    vi.stubEnv('AGENT_ROOM_STATE_FILE', stateFile);
    try {
      const { applyStopContinuationBudget } = await import('../src/hook.js');
      const { readState } = await import('../src/state.js');

      for (let expected = 1; expected <= 3; expected += 1) {
        await expect(applyStopContinuationBudget('scoped', 3)).resolves.toEqual({
          decision: 'block',
          streak: expected,
        });
      }

      const released = await applyStopContinuationBudget('scoped', 3);
      expect(released).toMatchObject({ decision: 'allow', streak: 0 });
      expect(released.reason).toContain('after 3 consecutive room continuations that delivered no new messages');
      expect((await readState()).blockStreak).toBe(0);

      // The allow is a real reset, not a permanently exhausted budget.
      await expect(applyStopContinuationBudget('scoped', 3)).resolves.toEqual({
        decision: 'block',
        streak: 1,
      });
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('never trips while the room is actually delivering messages', async () => {
    // The fuse exists for a client that spins. A room that keeps handing the
    // agent real messages is the opposite of spinning, and a Cursor session
    // driven by followup_message does one continuation per message — so if
    // deliveries counted, a busy meeting would release the agent within
    // minutes. resetBlockStreak on the delivering path is what prevents that.
    const dir = await fs.mkdtemp(join(tmpdir(), 'agent-room-hook-progress-'));
    const stateFile = join(dir, 'state.json');
    await fs.writeFile(stateFile, JSON.stringify({ version: 1, rooms: {}, blockStreak: 0 }));

    vi.resetModules();
    vi.stubEnv('AGENT_ROOM_STATE_FILE', stateFile);
    try {
      const { applyStopContinuationBudget } = await import('../src/hook.js');
      const { readState, resetBlockStreak } = await import('../src/state.js');

      // Two idle nudges, then a real delivery, repeated well past the limit.
      for (let cycle = 0; cycle < 10; cycle += 1) {
        await applyStopContinuationBudget('scoped', 3);
        await applyStopContinuationBudget('scoped', 3);
        // What the delivering path does before writing its continuation.
        await resetBlockStreak();
        expect((await readState()).blockStreak).toBe(0);
      }

      // 30 continuations later the fuse has still never fired.
      const next = await applyStopContinuationBudget('scoped', 3);
      expect(next).toEqual({ decision: 'block', streak: 1 });
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('roomBelongsToSession', () => {
  const base = { name: 'Antigravity', cursor: 1, joinedAt: 1 };

  beforeEach(() => {
    vi.stubEnv('CLAUDECODE', '');
    vi.stubEnv('CLAUDE_CODE_ENTRYPOINT', '');
  });

  it('allows unclaimed rooms when the hook has no session identity (legacy)', () => {
    expect(roomBelongsToSession(base, undefined)).toBe(true);
  });

  // The regression that shipped in 0.26.6: a Codex Stop payload with no
  // session_id resolved to undefined and took the "legacy" path, so an
  // unrelated Codex thread kept receiving the room contract for a room another
  // session had already claimed. A claimed room + an anonymous caller must
  // fail closed.
  it('rejects a claimed room when the hook has no session identity', () => {
    expect(roomBelongsToSession({ ...base, sessionKey: 'other' }, undefined)).toBe(false);
  });

  it('allows unclaimed rooms (caller may claim)', () => {
    expect(roomBelongsToSession(base, 'sess-a')).toBe(true);
  });

  it('allows rooms claimed by this session', () => {
    expect(roomBelongsToSession({ ...base, sessionKey: 'sess-a' }, 'sess-a')).toBe(true);
  });

  it('rejects rooms claimed by a different session', () => {
    expect(roomBelongsToSession({ ...base, sessionKey: 'sess-a' }, 'sess-b')).toBe(false);
  });

  it('rejects unclaimed rooms joined by a different harness client kind', () => {
    // If the room was joined by Antigravity, but current client is Codex, it should reject
    vi.stubEnv('CODEX_RUN_ID', 'test-run'); // force client kind to 'codex'
    const roomWithClient = { ...base, clientKind: 'antigravity' };
    expect(roomBelongsToSession(roomWithClient, 'some-session')).toBe(false);
  });

  it('allows unclaimed rooms joined by the same harness client kind', () => {
    vi.stubEnv('CODEX_RUN_ID', 'test-run'); // force client kind to 'codex'
    const roomWithClient = { ...base, clientKind: 'codex' };
    expect(roomBelongsToSession(roomWithClient, 'some-session')).toBe(true);
  });

  // 2026-08-19, Claude desktop app. The MCP server is spawned from
  // claude_desktop_config.json, which carried no CLAUDECODE marker, so it
  // stamped every room `clientKind: 'unknown'`. The Stop hook is spawned by
  // Claude Code itself, sees CLAUDECODE=1, and resolves 'claude-code'. The
  // kinds never matched, so this function rejected the room, the hook emitted
  // no keep-alive, and the agent dropped out one turn after joining. 'unknown'
  // means "detection failed", never "belongs to another client".
  describe("'unknown' is a detection failure, not a different owner", () => {
    // detectHarness reads the real environment, and the machine running the
    // suite may well BE a Codex / Cursor / VS Code session. Blank every marker
    // so each case controls the kind it is actually testing.
    beforeEach(() => {
      for (const key of [
        'CODEX_RUN_ID', 'CODEX_HOME', 'CURSOR_TRACE_ID', 'CURSOR_AGENT',
        'ANTIGRAVITY_CLI', 'ANTIGRAVITY', 'GOOGLE_ANTIGRAVITY', 'GEMINI_CLI',
        'GOOGLE_GEMINI_CLI', 'CLAUDE_DESKTOP_VERSION', '__CFBundleIdentifier',
        'CLINE_VERSION', 'WINDSURF_VERSION', 'TERM_PROGRAM', 'GITHUB_COPILOT',
        'COPILOT_AGENT', 'VSCODE_COPILOT', 'VSCODE_GITHUB_COPILOT', 'VSCODE_PID',
        'VSCODE_CWD', 'VSCODE_IPC_HOOK_CLI', 'AGENT_ROOM_RUN_ID',
      ]) vi.stubEnv(key, '');
    });

    it('allows a room stamped unknown when the hook resolves claude-code', () => {
      vi.stubEnv('CLAUDECODE', '1');
      expect(roomBelongsToSession({ ...base, clientKind: 'unknown' }, 'sess-a')).toBe(true);
    });

    it('allows a room stamped claude-code when the hook itself resolves unknown', () => {
      vi.stubEnv('CLAUDECODE', '');
      vi.stubEnv('CLAUDE_CODE_ENTRYPOINT', '');
      expect(roomBelongsToSession({ ...base, clientKind: 'claude-code' }, 'sess-a')).toBe(true);
    });

    it('still partitions two clients that both identified themselves', () => {
      vi.stubEnv('CLAUDECODE', '1');
      expect(roomBelongsToSession({ ...base, clientKind: 'cursor' }, 'sess-a')).toBe(false);
    });

    it('does not let the wildcard override an explicit session owner', () => {
      vi.stubEnv('CLAUDECODE', '1');
      const claimed = { ...base, clientKind: 'unknown', sessionKey: 'sess-a' };
      expect(roomBelongsToSession(claimed, 'sess-b')).toBe(false);
    });
  });

  // The hole clientKind alone does not close: Robin's Reddit chat and the chat
  // that joined the room were BOTH Codex, so they share one clientKind
  // partition. The room is unclaimed until someone hits Stop, and until 0.26.9
  // "someone" meant whichever thread got there first. ownerRunId is recorded at
  // join, so the room is never up for grabs.
  describe('ownerRunId (bound at join, not claimed at Stop)', () => {
    it('rejects an unclaimed room joined by a sibling thread of the same client kind', () => {
      vi.stubEnv('CODEX_RUN_ID', 'reddit-thread');
      const joinedByOtherThread = { ...base, clientKind: 'codex', ownerRunId: 'room-thread' };
      // No sessionKey: pre-0.26.10 this returned true and the Reddit thread
      // claimed the room on its next Stop.
      expect(roomBelongsToSession(joinedByOtherThread, 'reddit-session')).toBe(false);
    });

    it('allows the thread that actually joined the room', () => {
      vi.stubEnv('CODEX_RUN_ID', 'room-thread');
      const own = { ...base, clientKind: 'codex', ownerRunId: 'room-thread' };
      expect(roomBelongsToSession(own, 'room-session')).toBe(true);
    });

    it('stays permissive when the harness exposes no run id (no regression)', () => {
      // Antigravity et al. expose nothing thread-scoped; ownerRunId must not
      // make ownership stricter than the harness can support.
      vi.stubEnv('CODEX_RUN_ID', '');
      vi.stubEnv('CURSOR_TRACE_ID', '');
      vi.stubEnv('AGENT_ROOM_RUN_ID', '');
      vi.stubEnv('CLAUDE_CODE_SESSION_ID', '');
      const room = { ...base, ownerRunId: 'some-other-run' };
      expect(roomBelongsToSession(room, undefined)).toBe(true);
    });

    it('ignores ownerRunId on legacy records that predate it', () => {
      vi.stubEnv('CODEX_RUN_ID', 'reddit-thread');
      expect(roomBelongsToSession({ ...base, clientKind: 'codex' }, undefined)).toBe(true);
    });
  });
});

describe('roomsFromTranscript', () => {
  const line = (content: unknown) => JSON.stringify({ type: 'assistant', message: { content } });
  const use = (id: string, name: string, input: unknown) =>
    line([{ type: 'tool_use', id, name, input }]);
  const result = (id: string, body: unknown) =>
    line([{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: JSON.stringify(body) }] }]);

  it('recovers the room, the display name, and the latest cursor', async () => {
    const { roomsFromTranscript } = await import('../src/hook.js');
    const text = [
      line([{ type: 'text', text: 'unrelated chatter' }]),
      use('t1', 'mcp__agent-room__room_join', { code: 'ABC-DEF-GHJ', name: 'Claude' }),
      result('t1', { cursor: 3, assignedName: 'Claude', listenStatus: 'active' }),
      use('t2', 'mcp__agent-room__room_listen', { code: 'ABC-DEF-GHJ', since: 3, name: 'Claude' }),
      result('t2', { cursor: 11, listenStatus: 'active' }),
      'not json at all',
    ].join('\n');

    expect(roomsFromTranscript(text)).toEqual([
      { code: 'ABC-DEF-GHJ', name: 'Claude', cursor: 11 },
    ]);
  });

  it('does not resurrect a room that ended or removed this agent', async () => {
    const { roomsFromTranscript } = await import('../src/hook.js');
    for (const status of ['ended', 'removed']) {
      const text = [
        use('t1', 'mcp__agent-room__room_join', { code: 'ABC-DEF-GHJ', name: 'Claude' }),
        use('t2', 'mcp__agent-room__room_listen', { code: 'ABC-DEF-GHJ', since: 1, name: 'Claude' }),
        result('t2', { cursor: 9, listenStatus: status }),
      ].join('\n');
      expect(roomsFromTranscript(text)).toEqual([]);
    }
  });

  it('honours an explicit room_leave', async () => {
    const { roomsFromTranscript } = await import('../src/hook.js');
    const text = [
      use('t1', 'mcp__agent-room__room_join', { code: 'ABC-DEF-GHJ', name: 'Claude' }),
      use('t2', 'mcp__agent-room__room_leave', { code: 'ABC-DEF-GHJ', name: 'Claude' }),
    ].join('\n');
    expect(roomsFromTranscript(text)).toEqual([]);
  });

  it('keeps the name from the join when a later call omits it', async () => {
    const { roomsFromTranscript } = await import('../src/hook.js');
    const text = [
      use('t1', 'mcp__agent-room__room_join', { code: 'ABC-DEF-GHJ', name: 'Claude' }),
      use('t2', 'mcp__agent-room__room_task', { code: 'ABC-DEF-GHJ', action: 'list' }),
    ].join('\n');
    expect(roomsFromTranscript(text)).toEqual([
      { code: 'ABC-DEF-GHJ', name: 'Claude', cursor: 0 },
    ]);
  });

  it('ignores a room it only ever read about, with no code of its own', async () => {
    const { roomsFromTranscript } = await import('../src/hook.js');
    const text = [
      line([{ type: 'text', text: 'someone pasted https://www.agent-room.com/j/ZZZ-ZZZ-ZZZ' }]),
    ].join('\n');
    expect(roomsFromTranscript(text)).toEqual([]);
  });
});
