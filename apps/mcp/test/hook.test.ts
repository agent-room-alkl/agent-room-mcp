import { describe, expect, it } from 'vitest';
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
});
