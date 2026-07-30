// buildRoomRetro derives the retro purely from what the room already stored:
// chat volume from messages, turn friction from sys-event metadata, and task
// timelines/rejection counts from the board + the task_update sys trail
// (the board only keeps the LATEST verdict, so the trail is the only place
// repeated rejections survive).

import { describe, expect, it } from 'vitest';
import type { Message, TaskBoard } from '@agent-room/shared';
import { buildRoomRetro } from '../src/retro.js';

const T0 = 1_700_000_000_000;

function msg(partial: Partial<Message> & Pick<Message, 'name' | 'text' | 'time'>): Message {
  return {
    id: partial.time,
    type: 'msg',
    initials: 'XX',
    color: '#000',
    role: '',
    client: 'cc',
    ...partial,
  } as Message;
}

function sys(text: string, time: number, metadata: Message['metadata']): Message {
  return msg({ name: 'system', text, time, type: 'sys', metadata });
}

const room = {
  createdAt: T0,
  participants: [
    { name: 'Alice', role: 'PM', color: '#111', initials: 'AL', client: 'web' as const, joinedAt: T0, lastSeenAt: T0 },
    { name: 'Claude', role: 'Dev', color: '#222', initials: 'CL', client: 'cc' as const, joinedAt: T0, lastSeenAt: T0 },
    { name: 'Codex', role: 'Reviewer', color: '#333', initials: 'CO', client: 'cc' as const, joinedAt: T0, lastSeenAt: T0 },
  ],
};

const messages: Message[] = [
  msg({ name: 'Alice', client: 'web', text: 'kick off', time: T0 + 1_000 }),
  msg({ name: 'Claude', text: 'a'.repeat(300), time: T0 + 2_000 }),
  msg({ name: 'Claude', text: 'b'.repeat(100), time: T0 + 3_000 }),
  msg({ name: 'Codex', text: 'c'.repeat(100), time: T0 + 4_000 }),
  sys('🔵 T-01 "ship the thing" — claimed by Claude (now in_progress).', T0 + 5_000, { eventType: 'task_update' }),
  sys('🔴 T-01 "ship the thing" — rejected by Codex (now rejected).', T0 + 6_000, { eventType: 'task_update' }),
  sys('🔴 T-01 "ship the thing" — rejected by Codex (now rejected).', T0 + 7_000, { eventType: 'task_update' }),
  sys('Codex timed out.', T0 + 8_000, { eventType: 'timed_out', targetAgentName: 'Codex', targetAgentClient: 'cc' }),
  sys('Claude skipped by host.', T0 + 9_000, { eventType: 'skipped_by_host', targetAgentName: 'Claude', targetAgentClient: 'cc' }),
];

const board: TaskBoard = {
  code: 'AAA-BBB-CCC',
  version: 2,
  tasks: [
    {
      id: 'T-01', title: 'ship the thing', state: 'done',
      owner: 'Claude', verifier: 'Codex',
      createdBy: 'Alice', createdAt: T0 + 4_500, updatedAt: T0 + 60_000,
      evidence: { fileListing: 'ls', fileExcerpt: 'x', runOutput: 'ok', exitCode: 0, submittedBy: 'Claude', submittedClient: 'cc', at: T0 + 30_000 },
      verdict: { verdict: 'done', by: 'Codex', byClient: 'cc', at: T0 + 60_000 },
      roleHistory: [{ by: 'Alice', byClient: 'web', at: T0 + 10_000, field: 'owner', from: 'Codex', to: 'Claude' }],
    },
    { id: 'T-02', title: 'write docs', state: 'todo', createdBy: 'Alice', createdAt: T0 + 5_000, updatedAt: T0 + 5_000 },
  ],
};

describe('buildRoomRetro', () => {
  const retro = buildRoomRetro(room, messages, board);

  it('computes chat volume and share per participant', () => {
    const claude = retro.participants.find(p => p.name === 'Claude')!;
    const codex = retro.participants.find(p => p.name === 'Codex')!;
    expect(claude.messages).toBe(2);
    expect(claude.chars).toBe(400);
    expect(codex.messages).toBe(1);
    // 400 of 508 chars ≈ 79%
    expect(claude.sharePct).toBeGreaterThan(70);
    expect(retro.messageCount).toBe(4);
    expect(retro.sysEventCount).toBe(5);
  });

  it('attributes timeouts and skips from sys metadata', () => {
    expect(retro.totals.timeouts).toBe(1);
    expect(retro.totals.skips).toBe(1);
    expect(retro.participants.find(p => p.name === 'Codex')!.timeouts).toBe(1);
    expect(retro.participants.find(p => p.name === 'Claude')!.skips).toBe(1);
  });

  it('builds task timelines with rejections from the sys trail', () => {
    const t1 = retro.tasks!.find(t => t.id === 'T-01')!;
    expect(t1.rejections).toBe(2);            // two rejected events despite final done
    expect(t1.claimedAt).toBe(T0 + 5_000);    // first (now in_progress) event
    expect(t1.submittedAt).toBe(T0 + 30_000);
    expect(t1.decidedAt).toBe(T0 + 60_000);
    expect(t1.cycleMs).toBe(55_500);          // createdAt → decidedAt
    expect(t1.reassignments).toBe(1);
    expect(retro.totals.tasksDone).toBe(1);
    expect(retro.totals.tasksOpen).toBe(1);
    expect(retro.totals.rejections).toBe(2);
  });

  it('counts a lone rejected latest-verdict at least once when the trail is gone', () => {
    const trimmed = buildRoomRetro(room, [], {
      ...board,
      tasks: [{
        ...board.tasks[0]!,
        state: 'rejected',
        verdict: { verdict: 'rejected', by: 'Codex', byClient: 'cc', at: T0 + 60_000 },
      }],
    });
    expect(trimmed.tasks![0]!.rejections).toBe(1);
  });

  it('degrades gracefully: no board → no tasks; empty room → zeros', () => {
    const bare = buildRoomRetro(room, [], null);
    expect(bare.tasks).toBeUndefined();
    expect(bare.totals).toEqual({ timeouts: 0, skips: 0, rejections: 0, tasksDone: 0, tasksOpen: 0 });
    expect(bare.durationMs).toBe(0);
  });
});
