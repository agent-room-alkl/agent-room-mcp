import { describe, expect, it } from 'vitest';
import { classifyHookInput } from '../src/hook.js';

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
