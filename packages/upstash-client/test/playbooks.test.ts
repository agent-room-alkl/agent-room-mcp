// R3: buildPlaybookFromRoom snapshots STRUCTURE only — roles, mode, task
// skeleton — never run-state (evidence, verdicts, timestamps). Official
// playbooks are data; this pins their internal consistency so a typo in a
// role name can't ship a playbook whose tasks reference nobody.

import { describe, expect, it } from 'vitest';
import type { TaskBoard } from '@agent-room/shared';
import {
  buildPlaybookFromRoom,
  MAX_PLAYBOOK_ROLES,
  OFFICIAL_PLAYBOOKS,
  getOfficialPlaybook,
  playbookIdFromName,
} from '../src/playbooks.js';

const T0 = 1_700_000_000_000;

const room = {
  code: 'AAA-BBB-CCC',
  topic: 'ship the feature',
  replyMode: 'sequential' as const,
  modeConfig: { leadAgentName: 'Claude', leadAgentClient: 'cc' as const },
  participants: [
    { name: 'Robin', role: 'Host', color: '#1', initials: 'RO', client: 'web' as const, joinedAt: T0, lastSeenAt: T0 },
    { name: 'Claude', role: 'Dev', color: '#2', initials: 'CL', client: 'cc' as const, joinedAt: T0, lastSeenAt: T0 },
    { name: 'Claude', role: 'Dev (rejoined)', color: '#2', initials: 'CL', client: 'cc' as const, joinedAt: T0 + 1, lastSeenAt: T0 + 1 },
    { name: 'Codex', role: '', color: '#3', initials: 'CO', client: 'cc' as const, joinedAt: T0, lastSeenAt: T0 },
  ],
};

const board: TaskBoard = {
  code: 'AAA-BBB-CCC',
  version: 3,
  tasks: [
    {
      id: 'T-01', title: 'build it', state: 'done', dod: 'tests pass',
      owner: 'Claude', verifier: 'Codex',
      createdBy: 'Robin', createdAt: T0, updatedAt: T0 + 9,
      evidence: { fileListing: 'ls', fileExcerpt: 'x', runOutput: 'ok', exitCode: 0, submittedBy: 'Claude', submittedClient: 'cc', at: T0 + 5 },
      verdict: { verdict: 'done', by: 'Codex', byClient: 'cc', at: T0 + 9 },
    },
    { id: 'T-02', title: 'document it', state: 'in_progress', createdBy: 'Robin', createdAt: T0, updatedAt: T0 },
  ],
};

describe('playbookIdFromName', () => {
  it('slugs names and returns null for unusable ones', () => {
    expect(playbookIdFromName('  Code Review Crew! ')).toBe('code-review-crew');
    expect(playbookIdFromName('周会复盘')).toBe('周会复盘');
    expect(playbookIdFromName('!!!')).toBeNull();
    expect(playbookIdFromName('')).toBeNull();
  });

  it('same name → same id (the overwrite contract)', () => {
    expect(playbookIdFromName('My Flow')).toBe(playbookIdFromName('my flow'));
  });
});

describe('buildPlaybookFromRoom', () => {
  const pb = buildPlaybookFromRoom(room, board, 'Ship flow', T0 + 100)!;

  it('captures roles deduped by name, keeping the first role text', () => {
    expect(pb.roles.map(r => r.name)).toEqual(['Robin', 'Claude', 'Codex']);
    expect(pb.roles.find(r => r.name === 'Claude')!.role).toBe('Dev');
    expect(pb.roles.find(r => r.name === 'Codex')!.role).toBe('Participant');
  });

  it('keeps the task skeleton and drops all run-state', () => {
    expect(pb.tasks).toEqual([
      { title: 'build it', dod: 'tests pass', owner: 'Claude', verifier: 'Codex' },
      { title: 'document it' },
    ]);
  });

  it('carries mode + topic and stamps ids/times', () => {
    expect(pb.id).toBe('ship-flow');
    expect(pb.replyMode).toBe('sequential');
    expect(pb.modeConfig?.leadAgentName).toBe('Claude');
    expect(pb.sourceRoomCode).toBe('AAA-BBB-CCC');
    expect(pb.createdAt).toBe(T0 + 100);
  });

  it('degrades: no board → no tasks; bad name → null; role cap holds', () => {
    expect(buildPlaybookFromRoom(room, null, 'x', T0)!.tasks).toEqual([]);
    expect(buildPlaybookFromRoom(room, board, '###', T0)).toBeNull();
    const crowded = {
      ...room,
      participants: Array.from({ length: 20 }, (_, i) => ({
        ...room.participants[1]!, name: `A${i}`,
      })),
    };
    expect(buildPlaybookFromRoom(crowded, null, 'big', T0)!.roles).toHaveLength(MAX_PLAYBOOK_ROLES);
  });
});

describe('OFFICIAL_PLAYBOOKS', () => {
  it('ids are unique and resolvable', () => {
    const ids = OFFICIAL_PLAYBOOKS.map(p => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(getOfficialPlaybook(id)?.id).toBe(id);
    expect(getOfficialPlaybook('nope')).toBeNull();
  });

  it('every task owner/verifier references a declared role and differs', () => {
    for (const pb of OFFICIAL_PLAYBOOKS) {
      const names = new Set(pb.roles.map(r => r.name));
      for (const t of pb.tasks) {
        if (t.owner) expect(names.has(t.owner), `${pb.id}:${t.title} owner`).toBe(true);
        if (t.verifier) expect(names.has(t.verifier), `${pb.id}:${t.title} verifier`).toBe(true);
        if (t.owner && t.verifier) expect(t.owner).not.toBe(t.verifier);
      }
      expect(pb.official).toBe(true);
      expect(pb.roles.length).toBeGreaterThanOrEqual(2);
    }
  });
});
