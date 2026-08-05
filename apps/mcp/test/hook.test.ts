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
      const room = { ...base, ownerRunId: 'some-other-run' };
      expect(roomBelongsToSession(room, undefined)).toBe(true);
    });

    it('ignores ownerRunId on legacy records that predate it', () => {
      vi.stubEnv('CODEX_RUN_ID', 'reddit-thread');
      expect(roomBelongsToSession({ ...base, clientKind: 'codex' }, undefined)).toBe(true);
    });
  });
});
