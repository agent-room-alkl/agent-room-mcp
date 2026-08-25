import { describe, expect, it } from 'vitest';
import type { Room } from '@agent-room/shared';
import { ROOM_POLICY_VERSION } from '@agent-room/shared';
import { listenPolicyBrief } from '../src/tools.js';

// The room policy reaches an agent exactly once — in the join payload. That is
// not enough: it is invisible 170 messages later, and setReplyMode can swap the
// contract under a live agent. Worst case is the Moderator, whose one-line
// policy is actually the SUB-AGENT contract ("reply when assigned or directly
// addressed"): read by the moderator itself it says "you were addressed, so
// answer", and it does the work instead of assigning it.

const room = {
  code: 'AAA-BBB-CCC',
  topic: 't',
  createdAt: 0,
  createdBy: 'robin',
  status: 'active',
  version: 1,
  replyMode: 'moderator',
  modeConfig: { moderatorAgentName: 'Claude', moderatorAgentClient: 'cc' },
  participants: [
    { name: 'robin', role: '', color: '#000', initials: 'RO', client: 'web', joinedAt: 0, lastSeenAt: 0 },
    { name: 'Claude', role: '', color: '#001', initials: 'CL', client: 'cc', joinedAt: 1, lastSeenAt: 1 },
    { name: 'Codex', role: '', color: '#002', initials: 'CO', client: 'cc', joinedAt: 2, lastSeenAt: 2 },
  ],
} as unknown as Room;

describe('listenPolicyBrief — re-brief on every listen that returns messages', () => {
  it('gives the configured Moderator its own job description', () => {
    const brief = listenPolicyBrief(room, 'Claude', 3);
    expect(brief.isModerator).toBe(true);
    expect(brief.policyVersion).toBe(ROOM_POLICY_VERSION);
    expect(brief.roomPolicy).toContain('not a switchboard');
    expect(brief.roomPolicy).toContain('assign each piece BY NAME');
    expect(brief.roomPolicy).toContain('Do NOT take the heavy execution');
    expect(brief.roomPolicy).not.toContain('reply when assigned or directly addressed');
  });

  it('gives every other seat the member contract', () => {
    const brief = listenPolicyBrief(room, 'Codex', 3);
    expect(brief.isModerator).toBe(false);
    expect(brief.roomPolicy).toContain('reply when assigned or directly addressed');
    expect(brief.roomPolicy).not.toContain('not a switchboard');
  });

  it('stays silent on a quiet listen — nothing to act on, nothing to brief', () => {
    expect(listenPolicyBrief(room, 'Claude', 0)).toEqual({ isModerator: false });
  });

  it('stays silent when the caller has no known name', () => {
    expect(listenPolicyBrief(room, undefined, 5)).toEqual({ isModerator: false });
  });

  // A same-named agent on a different client is NOT the seat named in
  // modeConfig — moderator identity is (name, client), same as everywhere else.
  it('does not hand the Moderator brief to a same-named web participant', () => {
    const brief = listenPolicyBrief(room, 'robin', 2);
    expect(brief.isModerator).toBe(false);
  });

  it('carries the per-game rules through in game mode', () => {
    const gameRoom = {
      ...room,
      replyMode: 'game',
      modeConfig: { gameId: 'werewolf' },
    } as unknown as Room;
    const brief = listenPolicyBrief(gameRoom, 'Claude', 1);
    expect(brief.roomPolicy).toContain('Werewolf');
    expect(brief.roomPolicy).not.toContain('Open mode');
  });
});
