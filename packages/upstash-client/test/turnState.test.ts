import { describe, it, expect } from 'vitest';
import { FIRST_RESPONSE_GRACE_MS, TURN_HARD_CAP_MS } from '@agent-room/shared';
import type { Participant, Room } from '@agent-room/shared';
import {
  addHostDirected,
  advanceOnTimeout,
  advanceTurn,
  applyGraceSupplementReply,
  buildSupplementQueue,
  canAgentSpeakNow,
  consumeHostDirected,
  consumeHostDirectedDetailed,
  isCurrentSpeaker,
  isGraceSupplementSpeaker,
  isHumanSender,
  leadGraceMs,
  moderatorReply,
  myRoleInTurn,
  newModeratorTurn,
  newSequentialTurn,
  pickLeadForSequential,
  renewTurnDeadline,
  shouldStartNewTurn,
  skipQueueHead,
  timeoutForRole,
  type TurnState,
} from '../src/turnState.js';

function part(name: string, client: 'web' | 'cc', joinedAt: number, canSpeak = true): Participant {
  return { name, client, role: '', color: '#fff', initials: 'XX', joinedAt, lastSeenAt: joinedAt, canSpeak };
}

function room(overrides: Partial<Room> = {}): Room {
  return {
    code: 'TST-CDE-FGH',
    topic: 'discussion',
    createdAt: 0,
    createdBy: 'host',
    status: 'active',
    version: 1,
    participants: [
      part('host', 'web', 0),
      part('Lead', 'cc', 10),
      part('A', 'cc', 20),
      part('B', 'cc', 30),
    ],
    replyMode: 'sequential',
    ...overrides,
  };
}

describe('pickLeadForSequential', () => {
  it('honors explicit leadAgentName/Client from modeConfig', () => {
    const r = room({ modeConfig: { leadAgentName: 'A', leadAgentClient: 'cc' } });
    expect(pickLeadForSequential(r)).toEqual({ name: 'A', client: 'cc' });
  });

  it('falls back to first cc agent in join order when modeConfig is empty', () => {
    const r = room();
    expect(pickLeadForSequential(r)).toEqual({ name: 'Lead', client: 'cc' });
  });

  it('skips the host and any web-client participant', () => {
    const r = room({
      participants: [
        part('host', 'web', 0),
        part('humanGuest', 'web', 5),
        part('cc1', 'cc', 10),
      ],
    });
    expect(pickLeadForSequential(r)).toEqual({ name: 'cc1', client: 'cc' });
  });

  it('returns undefined when no cc agents are present', () => {
    const r = room({ participants: [part('host', 'web', 0)] });
    expect(pickLeadForSequential(r)).toBeUndefined();
  });

  it('falls back when modeConfig points to a Lead who has left the room', () => {
    const r = room({ modeConfig: { leadAgentName: 'Ghost', leadAgentClient: 'cc' } });
    // Ghost is not in participants → fall back to first cc agent in join order.
    expect(pickLeadForSequential(r)).toEqual({ name: 'Lead', client: 'cc' });
  });
});

describe('buildSupplementQueue', () => {
  it('lists cc agents in join order, excluding the Lead and the host', () => {
    const r = room();
    const queue = buildSupplementQueue(r, { name: 'Lead', client: 'cc' });
    expect(queue).toEqual([
      { name: 'A', client: 'cc', role: 'supplement' },
      { name: 'B', client: 'cc', role: 'supplement' },
    ]);
  });

  it('filters out muted agents', () => {
    const r = room({
      participants: [
        part('host', 'web', 0),
        part('Lead', 'cc', 10),
        part('A', 'cc', 20, /*canSpeak*/ false),
        part('B', 'cc', 30),
      ],
    });
    const queue = buildSupplementQueue(r, { name: 'Lead', client: 'cc' });
    expect(queue).toEqual([{ name: 'B', client: 'cc', role: 'supplement' }]);
  });
});

describe('newSequentialTurn', () => {
  it('returns null when no cc agents are present', () => {
    const r = room({ participants: [part('host', 'web', 0)] });
    expect(newSequentialTurn(r, 1)).toBeNull();
  });

  it('starts in lead_answer with Lead current, supplement queue in join order, no lead grace', () => {
    const r = room();
    const state = newSequentialTurn(r, 100, 1000)!;
    expect(state.turnId).toBe(1000);
    expect(state.mode).toBe('sequential');
    expect(state.phase).toBe('lead_answer');
    expect(state.leadName).toBe('Lead');
    expect(state.currentName).toBe('Lead');
    expect(state.currentRole).toBe('lead');
    expect(state.deadline).toBe(1000 + FIRST_RESPONSE_GRACE_MS); // first-response grace
    expect(state.hardDeadline).toBe(1000 + TURN_HARD_CAP_MS); // turn hard cap
    // T-16: dual-round uses strict order — no lead-grace preempt.
    expect(state.leadGraceUntil).toBeUndefined();
    expect(state.queue).toEqual([
      { name: 'A', client: 'cc', role: 'supplement' },
      { name: 'B', client: 'cc', role: 'supplement' },
    ]);
    expect(state.spoken).toEqual([]);
  });

  it('starts solo lead with empty queue and still no leadGraceUntil', () => {
    const r = room({ participants: [part('host', 'web', 0), part('Lead', 'cc', 10)] });
    const state = newSequentialTurn(r, 100, 1000)!;
    expect(state.queue).toEqual([]);
    expect(state.phase).toBe('lead_answer');
    expect(state.leadGraceUntil).toBeUndefined();
  });
});

describe('advanceTurn', () => {
  it('moves Lead into delta with queue head as current', () => {
    const r = room();
    const start = newSequentialTurn(r, 100, 1000)!;
    const after = advanceTurn(start, 'replied', r, 2000);
    expect(after.spoken).toEqual([
      { name: 'Lead', client: 'cc', role: 'lead', status: 'replied', at: 2000, round: 1 },
    ]);
    expect(after.phase).toBe('delta');
    expect(after.currentName).toBe('A');
    expect(after.currentRole).toBe('supplement');
    expect(after.deadline).toBe(2000 + FIRST_RESPONSE_GRACE_MS);
    expect(after.hardDeadline).toBe(2000 + TURN_HARD_CAP_MS);
    expect(after.queue).toEqual([{ name: 'B', client: 'cc', role: 'supplement' }]);
    expect(after.leadGraceUntil).toBeUndefined();
  });

  it('solo lead advances lead_answer → converge_draft (skips empty delta)', () => {
    const r = room({ participants: [part('host', 'web', 0), part('Lead', 'cc', 10)] });
    const start = newSequentialTurn(r, 100, 1000)!;
    expect(start.queue).toEqual([]);
    const after = advanceTurn(start, 'replied', r, 2000);
    expect(after.phase).toBe('converge_draft');
    expect(after.currentName).toBe('Lead');
    expect(after.currentRole).toBe('wrap');
    expect(after.queue).toEqual([]);
    expect(after.spoken).toEqual([
      { name: 'Lead', client: 'cc', role: 'lead', status: 'replied', at: 2000, round: 1 },
    ]);
  });

  it('honors `no_addition` as a status without otherwise differing from `replied`', () => {
    const r = room();
    const start = newSequentialTurn(r, 100, 1000)!;
    const second = advanceTurn(start, 'replied', r, 2000);
    const third = advanceTurn(second, 'no_addition', r, 3000);
    expect(third.spoken[1]).toEqual({
      name: 'A', client: 'cc', role: 'supplement', status: 'no_addition', at: 3000, round: 1,
    });
    expect(third.phase).toBe('delta');
    expect(third.currentName).toBe('B');
  });
});

describe('sequential dual-round', () => {
  it('walks lead_answer → delta → converge_draft → patch → final → end', () => {
    const r = room(); // host, Lead, A, B
    let state = newSequentialTurn(r, 1, 1000)!;
    expect(state.phase).toBe('lead_answer');

    state = advanceTurn(state, 'replied', r, 2000); // → delta, A
    expect(state.phase).toBe('delta');
    expect(state.currentName).toBe('A');

    state = advanceTurn(state, 'replied', r, 3000); // B
    expect(state.currentName).toBe('B');
    expect(state.phase).toBe('delta');

    state = advanceTurn(state, 'replied', r, 4000); // → converge_draft
    expect(state.phase).toBe('converge_draft');
    expect(state.currentName).toBe('Lead');
    expect(state.currentRole).toBe('wrap');
    expect(state.queue).toEqual([]);

    state = advanceTurn(state, 'replied', r, 5000); // → patch, A
    expect(state.phase).toBe('patch');
    expect(state.currentName).toBe('A');
    expect(state.queue).toEqual([{ name: 'B', client: 'cc', role: 'supplement' }]);

    state = advanceTurn(state, 'replied', r, 6000); // B
    expect(state.currentName).toBe('B');
    expect(state.phase).toBe('patch');

    state = advanceTurn(state, 'replied', r, 7000); // → final
    expect(state.phase).toBe('final');
    expect(state.currentName).toBe('Lead');
    expect(state.currentRole).toBe('wrap');

    const ended = advanceTurn(state, 'replied', r, 8000);
    expect(ended.currentName).toBeUndefined();
    expect(ended.currentRole).toBeUndefined();
    expect(ended.deadline).toBeUndefined();
    expect(ended.phase).toBe('final');
  });

  it('does not restart rounds — peers get exactly one delta and one patch', () => {
    const r = room();
    let state = newSequentialTurn(r, 1, 1000)!;
    // Full dual-round with skips in delta/patch still ends after final.
    state = advanceTurn(state, 'replied', r, 2000); // delta A
    state = advanceTurn(state, 'no_addition', r, 3000); // A skip
    state = advanceTurn(state, 'no_addition', r, 4000); // B skip → draft
    expect(state.phase).toBe('converge_draft');
    state = advanceTurn(state, 'replied', r, 5000); // patch A
    state = advanceTurn(state, 'replied', r, 6000); // A approve
    state = advanceTurn(state, 'replied', r, 7000); // B approve → final
    expect(state.phase).toBe('final');
    const ended = advanceTurn(state, 'replied', r, 8000);
    expect(ended.currentName).toBeUndefined();
    // Each peer appears at most twice as supplement (delta + patch).
    const aSupp = ended.spoken.filter(s => s.name === 'A' && s.role === 'supplement');
    const bSupp = ended.spoken.filter(s => s.name === 'B' && s.role === 'supplement');
    expect(aSupp).toHaveLength(2);
    expect(bSupp).toHaveLength(2);
  });

  it('solo lead: lead_answer → converge_draft → final → end', () => {
    const r = room({ participants: [part('host', 'web', 0), part('Lead', 'cc', 10)] });
    let state = newSequentialTurn(r, 1, 1000)!;
    state = advanceTurn(state, 'replied', r, 2000);
    expect(state.phase).toBe('converge_draft');
    state = advanceTurn(state, 'replied', r, 3000);
    expect(state.phase).toBe('final');
    const ended = advanceTurn(state, 'replied', r, 4000);
    expect(ended.currentName).toBeUndefined();
  });

  it('fresh deadline on each phase handoff', () => {
    const r = room({ participants: [part('host', 'web', 0), part('Lead', 'cc', 10)] });
    const start = newSequentialTurn(r, 1, 1000)!;
    const draft = advanceTurn(start, 'replied', r, 2000);
    expect(draft.phase).toBe('converge_draft');
    const { state, skipped } = advanceOnTimeout(draft, r, 3000); // 3000 < deadline
    expect(skipped).toEqual([]);
    expect(state?.currentName).toBe('Lead');
    expect(state?.phase).toBe('converge_draft');
  });

  it('ends when lead leaves before converge_draft', () => {
    const r = room();
    let state = newSequentialTurn(r, 1, 1000)!;
    state = advanceTurn(state, 'replied', r, 2000); // A
    state = advanceTurn(state, 'replied', r, 3000); // B
    const rNoAgents = room({ participants: [part('host', 'web', 0)] });
    const ended = advanceTurn(state, 'replied', rNoAgents, 4000);
    expect(ended.currentName).toBeUndefined();
    expect(ended.currentRole).toBeUndefined();
    expect(ended.deadline).toBeUndefined();
  });

  it('moderator mode: advanceTurn on an empty queue clears', () => {
    const r = room({
      replyMode: 'moderator',
      modeConfig: { moderatorAgentName: 'Lead', moderatorAgentClient: 'cc' },
    });
    const start = newModeratorTurn(r, 1, 1000)!;
    expect(start.queue).toEqual([]);
    const after = advanceTurn(start, 'skipped', r, 2000);
    expect(after.currentName).toBeUndefined();
    expect(after.currentRole).toBeUndefined();
  });
});

describe('renewTurnDeadline', () => {
  it('pushes a sequential current speaker deadline out by the renewal window', () => {
    const r = room();
    const start = newSequentialTurn(r, 1, 1000)!; // deadline 61_000, hardDeadline 601_000
    // Heartbeat at t=30_000 → deadline = min(30_000 + 300_000, 601_000).
    const renewed = renewTurnDeadline(start, 30_000);
    expect(renewed.deadline).toBe(330_000);
    expect(renewed.hardDeadline).toBe(601_000); // ceiling never moves
  });

  it('caps the renewed deadline at hardDeadline', () => {
    const r = room();
    const start = newSequentialTurn(r, 1, 1000)!; // hardDeadline 601_000
    // Late heartbeat: 500_000 + 300_000 = 800_000 > hardDeadline → capped.
    const renewed = renewTurnDeadline(start, 500_000);
    expect(renewed.deadline).toBe(601_000);
  });

  it('keeps the later deadline — a heartbeat never shortens a turn', () => {
    const state: TurnState = {
      turnId: 1, mode: 'sequential',
      currentName: 'Lead', currentClient: 'cc', currentRole: 'lead',
      deadline: 500_000, hardDeadline: 600_000, queue: [], spoken: [],
    };
    // now=0 → renewed = min(300_000, 600_000) = 300_000, which is < 500_000.
    expect(renewTurnDeadline(state, 0).deadline).toBe(500_000);
  });

  it('is a no-op for moderator mode', () => {
    const r = room({
      replyMode: 'moderator',
      modeConfig: { moderatorAgentName: 'Lead', moderatorAgentClient: 'cc' },
    });
    const start = newModeratorTurn(r, 1, 1000)!;
    expect(renewTurnDeadline(start, 30_000)).toBe(start);
  });

  it('is a no-op when there is no current speaker', () => {
    const ended: TurnState = { turnId: 1, mode: 'sequential', queue: [], spoken: [] };
    expect(renewTurnDeadline(ended, 30_000)).toBe(ended);
  });
});

describe('advanceOnTimeout', () => {
  it('returns the same state when no deadline has passed', () => {
    const r = room();
    const start = newSequentialTurn(r, 100, 1000)!;
    const { state, skipped } = advanceOnTimeout(start, r, /*now*/ 1500);
    expect(state).toEqual(start);
    expect(skipped).toEqual([]);
  });

  it('skips the expired speaker and gives the successor a fresh first-response window', () => {
    const r = room();
    const stacked: TurnState = {
      turnId: 1,
      mode: 'sequential',
      phase: 'lead_answer',
      leadName: 'Lead',
      leadClient: 'cc',
      currentName: 'Lead',
      currentClient: 'cc',
      currentRole: 'lead',
      deadline: 100, // already passed at now=1000
      hardDeadline: 600_100,
      queue: [
        { name: 'A', client: 'cc', role: 'supplement' },
        { name: 'B', client: 'cc', role: 'supplement' },
      ],
      spoken: [],
    };
    // Only the Lead is skipped. The next speaker (A) becomes current with a
    // fresh 60s first-response window measured from `now`, so the cascade
    // stops there — speakers are never retroactively skipped for time that
    // passed before they actually had the floor.
    const { state, skipped } = advanceOnTimeout(stacked, r, 1000);
    expect(skipped.map(s => s.name)).toEqual(['Lead']);
    expect(skipped[0]?.status).toBe('timed_out');
    expect(state?.phase).toBe('delta');
    expect(state?.currentName).toBe('A');
    expect(state?.deadline).toBe(1000 + FIRST_RESPONSE_GRACE_MS);
    expect(state?.hardDeadline).toBe(1000 + TURN_HARD_CAP_MS);
    expect(state?.spoken).toHaveLength(1);
  });

  it('records patch-phase timeouts as abstained', () => {
    const r = room();
    const patching: TurnState = {
      turnId: 1,
      mode: 'sequential',
      phase: 'patch',
      leadName: 'Lead',
      leadClient: 'cc',
      currentName: 'A',
      currentClient: 'cc',
      currentRole: 'supplement',
      deadline: 100,
      hardDeadline: 600_100,
      queue: [{ name: 'B', client: 'cc', role: 'supplement' }],
      spoken: [],
      round: 1,
    };
    const { state, skipped } = advanceOnTimeout(patching, r, 1000);
    expect(skipped[0]?.status).toBe('abstained');
    expect(state?.spoken[0]?.status).toBe('abstained');
    expect(state?.currentName).toBe('B');
    expect(state?.phase).toBe('patch');
  });

  it('delta-phase timeout advances as timed_out (SKIP-equivalent) to the next peer', () => {
    const r = room();
    const deltaing: TurnState = {
      turnId: 1,
      mode: 'sequential',
      phase: 'delta',
      leadName: 'Lead',
      leadClient: 'cc',
      currentName: 'A',
      currentClient: 'cc',
      currentRole: 'supplement',
      deadline: 100,
      hardDeadline: 600_100,
      queue: [{ name: 'B', client: 'cc', role: 'supplement' }],
      spoken: [
        { name: 'Lead', client: 'cc', role: 'lead', status: 'replied', at: 50, round: 1 },
      ],
      round: 1,
    };
    const { state, skipped } = advanceOnTimeout(deltaing, r, 1000);
    expect(skipped[0]?.status).toBe('timed_out');
    expect(state?.spoken[1]?.status).toBe('timed_out');
    expect(state?.phase).toBe('delta');
    expect(state?.currentName).toBe('B');
  });

  it('patch-phase no_addition (provider abstain) maps to abstained and still advances', () => {
    const r = room();
    let state = newSequentialTurn(r, 1, 1000)!;
    state = advanceTurn(state, 'replied', r, 2000); // delta A
    state = advanceTurn(state, 'replied', r, 3000); // A
    state = advanceTurn(state, 'replied', r, 4000); // B → draft
    state = advanceTurn(state, 'replied', r, 5000); // → patch A
    expect(state.phase).toBe('patch');
    expect(state.currentName).toBe('A');
    state = advanceTurn(state, 'no_addition', r, 6000);
    expect(state.spoken.at(-1)?.status).toBe('abstained');
    expect(state.currentName).toBe('B');
    expect(state.phase).toBe('patch');
  });

  it('CHALLENGE then lead reject still completes dual-round (no deadlock)', () => {
    const r = room();
    let state = newSequentialTurn(r, 1, 1000)!;
    state = advanceTurn(state, 'replied', r, 2000); // lead
    state = advanceTurn(state, 'replied', r, 3000); // A CHALLENGE (machine treats as replied)
    state = advanceTurn(state, 'no_addition', r, 4000); // B skip → draft
    expect(state.phase).toBe('converge_draft');
    state = advanceTurn(state, 'replied', r, 5000); // lead draft listing 未解分歧
    state = advanceTurn(state, 'replied', r, 6000); // A PATCH rejected later by final
    state = advanceTurn(state, 'replied', r, 7000); // B APPROVE → final
    expect(state.phase).toBe('final');
    const ended = advanceTurn(state, 'replied', r, 8000);
    expect(ended.currentName).toBeUndefined();
    expect(ended.spoken.some(s => s.role === 'wrap')).toBe(true);
  });
});

describe('isCurrentSpeaker / isHumanSender / shouldStartNewTurn', () => {
  it('isCurrentSpeaker matches both name and client', () => {
    const r = room();
    const start = newSequentialTurn(r, 100, 1000)!;
    expect(isCurrentSpeaker(start, 'Lead', 'cc')).toBe(true);
    expect(isCurrentSpeaker(start, 'Lead', 'web')).toBe(false);
    expect(isCurrentSpeaker(start, 'A', 'cc')).toBe(false);
    expect(isCurrentSpeaker(null, 'Lead', 'cc')).toBe(false);
  });

  it('isHumanSender: web client, or the room host (even if cc)', () => {
    const r = room();
    expect(isHumanSender(r, 'host', 'web')).toBe(true);
    expect(isHumanSender(r, 'guest', 'web')).toBe(true);
    expect(isHumanSender(r, 'A', 'cc')).toBe(false);
    // Host masquerading as cc still counts as human.
    expect(isHumanSender(r, 'host', 'cc')).toBe(true);
  });

  it('shouldStartNewTurn returns false in open mode', () => {
    const r = room({ replyMode: 'open' });
    expect(shouldStartNewTurn(null, r)).toBe(false);
  });

  it('shouldStartNewTurn returns true when no turn is in flight in sequential mode', () => {
    const r = room();
    expect(shouldStartNewTurn(null, r)).toBe(true);
  });

  it('shouldStartNewTurn returns true when prior turn is complete (current cleared, queue empty)', () => {
    const r = room();
    const finished: TurnState = {
      turnId: 1, mode: 'sequential', queue: [], spoken: [
        { name: 'Lead', client: 'cc', role: 'lead', status: 'replied', at: 1 },
      ],
    };
    expect(shouldStartNewTurn(finished, r)).toBe(true);
  });

  it('shouldStartNewTurn returns false while a turn is still in flight', () => {
    const r = room();
    const inflight = newSequentialTurn(r, 1, 1)!;
    expect(shouldStartNewTurn(inflight, r)).toBe(false);
  });
});

describe('consumeHostDirected', () => {
  it('returns false on empty allowlist', () => {
    const state: TurnState = {
      turnId: 1, mode: 'sequential', queue: [], spoken: [],
    };
    expect(consumeHostDirected(state, 'A', 'cc')).toBe(false);
  });

  it('returns true and removes the matching entry', () => {
    const state: TurnState = {
      turnId: 1, mode: 'sequential', queue: [], spoken: [],
      hostDirected: [
        { name: 'A', client: 'cc', addedAt: 1 },
        { name: 'B', client: 'cc', addedAt: 2 },
      ],
    };
    expect(consumeHostDirected(state, 'A', 'cc')).toBe(true);
    expect(state.hostDirected).toEqual([{ name: 'B', client: 'cc', addedAt: 2 }]);
  });
});

describe('timeoutForRole', () => {
  it('returns the default for unconfigured roles', () => {
    const r = room();
    expect(timeoutForRole(r, 'lead')).toBe(600_000);
    expect(timeoutForRole(r, 'supplement')).toBe(600_000);
    expect(timeoutForRole(r, 'wrap')).toBe(600_000);
    expect(timeoutForRole(r, 'moderator')).toBe(600_000);
    expect(timeoutForRole(r, 'assignee')).toBe(600_000);
  });

  it('honors modeConfig.timeoutMs overrides', () => {
    const r = room({ modeConfig: { timeoutMs: { lead: 5_000, supplement: 1_000, wrap: 2_000 } } });
    expect(timeoutForRole(r, 'lead')).toBe(5_000);
    expect(timeoutForRole(r, 'supplement')).toBe(1_000);
    expect(timeoutForRole(r, 'wrap')).toBe(2_000);
    // Unconfigured roles still fall back.
    expect(timeoutForRole(r, 'moderator')).toBe(600_000);
  });

  it('returns Infinity for non-deadline roles (open, human, host_directed)', () => {
    const r = room();
    expect(timeoutForRole(r, 'open')).toBe(Number.POSITIVE_INFINITY);
    expect(timeoutForRole(r, 'human')).toBe(Number.POSITIVE_INFINITY);
    expect(timeoutForRole(r, 'host_directed')).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('newModeratorTurn', () => {
  it('returns null when no moderator is configured', () => {
    const r = room({ replyMode: 'moderator', modeConfig: {} });
    expect(newModeratorTurn(r, 1)).toBeNull();
  });

  it('returns null when configured moderator is absent from the room', () => {
    const r = room({
      replyMode: 'moderator',
      modeConfig: { moderatorAgentName: 'Ghost', moderatorAgentClient: 'cc' },
    });
    expect(newModeratorTurn(r, 1)).toBeNull();
  });

  it('returns null when configured moderator is muted', () => {
    const r = room({
      replyMode: 'moderator',
      modeConfig: { moderatorAgentName: 'Lead', moderatorAgentClient: 'cc' },
      participants: [
        part('host', 'web', 0),
        part('Lead', 'cc', 10, /*canSpeak*/ false),
      ],
    });
    expect(newModeratorTurn(r, 1)).toBeNull();
  });

  it('starts with moderator as current and empty queue', () => {
    const r = room({
      replyMode: 'moderator',
      modeConfig: { moderatorAgentName: 'Lead', moderatorAgentClient: 'cc' },
    });
    const state = newModeratorTurn(r, 100, 1000)!;
    expect(state.mode).toBe('moderator');
    expect(state.moderatorName).toBe('Lead');
    expect(state.currentName).toBe('Lead');
    expect(state.currentRole).toBe('moderator');
    expect(state.queue).toEqual([]);
    expect(state.deadline).toBe(1000 + 600_000); // default moderator timeout
  });
});

describe('moderatorReply', () => {
  it('keeps current = moderator, resets deadline, logs in spoken', () => {
    const r = room({
      replyMode: 'moderator',
      modeConfig: { moderatorAgentName: 'Lead', moderatorAgentClient: 'cc' },
    });
    const start = newModeratorTurn(r, 100, 1000)!;
    const after = moderatorReply(start, r, 5000);
    expect(after.currentName).toBe('Lead');
    expect(after.currentRole).toBe('moderator');
    expect(after.deadline).toBe(5000 + 600_000);
    expect(after.spoken).toEqual([
      { name: 'Lead', client: 'cc', role: 'moderator', status: 'replied', at: 5000 },
    ]);
  });
});

describe('addHostDirected / consumeHostDirectedDetailed', () => {
  it('records source on addHostDirected and surfaces it on consume', () => {
    const r = room();
    const start = newSequentialTurn(r, 100, 1000)!;
    const withDirected = addHostDirected(start, 'A', 'cc', 'moderator', 2000);
    const detailed = consumeHostDirectedDetailed(withDirected, 'A', 'cc');
    expect(detailed.consumed).toBe(true);
    expect(detailed.source).toBe('moderator');
  });

  it('defaults source to "host" when not specified', () => {
    const r = room();
    const start = newSequentialTurn(r, 100, 1000)!;
    const withDirected = addHostDirected(start, 'A', 'cc');
    const detailed = consumeHostDirectedDetailed(withDirected, 'A', 'cc');
    expect(detailed.source).toBe('host');
  });

  it('returns consumed=false when target is not in the allowlist', () => {
    const r = room();
    const start = newSequentialTurn(r, 100, 1000)!;
    expect(consumeHostDirectedDetailed(start, 'A', 'cc')).toEqual({ consumed: false });
  });

  it('addHostDirected is idempotent (no stacking)', () => {
    const r = room();
    let state = newSequentialTurn(r, 100, 1000)!;
    state = addHostDirected(state, 'A', 'cc', 'host', 2000);
    state = addHostDirected(state, 'A', 'cc', 'host', 3000); // duplicate
    expect(state.hostDirected).toHaveLength(1);
  });
});

describe('myRoleInTurn', () => {
  it('returns observer when no turn is active', () => {
    expect(myRoleInTurn(null, 'A', 'cc')).toBe('observer');
  });

  it('returns the role of the current speaker', () => {
    const r = room();
    const state = newSequentialTurn(r, 1, 1)!;
    expect(myRoleInTurn(state, 'Lead', 'cc')).toBe('lead');
  });

  it('returns "queued" for upcoming supplements while Lead holds the floor', () => {
    const r = room();
    const state = newSequentialTurn(r, 1, 1000)!;
    // Dual-round: no lead grace — supplements stay queued until they are current.
    expect(myRoleInTurn(state, 'A', 'cc', 6000)).toBe('queued');
    expect(myRoleInTurn(state, 'B', 'cc', 6000)).toBe('queued');
    expect(myRoleInTurn(state, 'A', 'cc', 25_000)).toBe('queued');
  });

  it('returns "spoken" once the participant has replied or been skipped', () => {
    const r = room();
    const start = newSequentialTurn(r, 1, 1)!;
    const after = advanceTurn(start, 'replied', r, 100);
    expect(myRoleInTurn(after, 'Lead', 'cc')).toBe('spoken');
    expect(myRoleInTurn(after, 'A', 'cc')).toBe('supplement'); // now current
  });

  it('returns "host_directed" when present in the one-shot allowlist', () => {
    const state: TurnState = {
      turnId: 1, mode: 'sequential', queue: [], spoken: [],
      hostDirected: [{ name: 'A', client: 'cc', addedAt: 0 }],
    };
    expect(myRoleInTurn(state, 'A', 'cc')).toBe('host_directed');
  });
});

describe('lead grace (legacy / opt-in only)', () => {
  it('leadGraceMs honors modeConfig override and falls back to default', () => {
    expect(leadGraceMs(room())).toBe(20_000);
    expect(leadGraceMs(room({ modeConfig: { leadGraceMs: 5_000 } }))).toBe(5_000);
  });

  it('T-16 new turns: only the current speaker may speak (grace disabled)', () => {
    const r = room();
    const state = newSequentialTurn(r, 1, 1000)!;
    expect(state.leadGraceUntil).toBeUndefined();
    expect(canAgentSpeakNow(state, 'Lead', 'cc', 5000)).toBe(true);
    expect(canAgentSpeakNow(state, 'A', 'cc', 5000)).toBe(false);
    expect(canAgentSpeakNow(state, 'A', 'cc', 25_000)).toBe(false);
    expect(isGraceSupplementSpeaker(state, 'A', 'cc', 25_000)).toBe(false);
  });

  it('canAgentSpeakNow: with explicit leadGraceUntil, queue head unlocks after grace', () => {
    const r = room();
    const state = { ...newSequentialTurn(r, 1, 1000)!, leadGraceUntil: 1000 + 20_000 };
    expect(canAgentSpeakNow(state, 'Lead', 'cc', 5000)).toBe(true);
    expect(canAgentSpeakNow(state, 'A', 'cc', 5000)).toBe(false);
    expect(canAgentSpeakNow(state, 'B', 'cc', 5000)).toBe(false);
    expect(canAgentSpeakNow(state, 'Lead', 'cc', 25_000)).toBe(true);
    expect(canAgentSpeakNow(state, 'A', 'cc', 25_000)).toBe(true);
    expect(canAgentSpeakNow(state, 'B', 'cc', 25_000)).toBe(false);
  });

  it('isGraceSupplementSpeaker distinguishes grace-path from current-speaker path', () => {
    const r = room();
    const state = { ...newSequentialTurn(r, 1, 1000)!, leadGraceUntil: 1000 + 20_000 };
    expect(isGraceSupplementSpeaker(state, 'Lead', 'cc', 25_000)).toBe(false); // is current
    expect(isGraceSupplementSpeaker(state, 'A', 'cc', 25_000)).toBe(true);     // grace path
    expect(isGraceSupplementSpeaker(state, 'A', 'cc', 5_000)).toBe(false);     // still in grace
  });

  it('myRoleInTurn surfaces the queue-head supplement as "supplement" after grace', () => {
    const r = room();
    const state = { ...newSequentialTurn(r, 1, 1000)!, leadGraceUntil: 1000 + 20_000 };
    expect(myRoleInTurn(state, 'A', 'cc', 5_000)).toBe('queued');
    expect(myRoleInTurn(state, 'A', 'cc', 25_000)).toBe('supplement');
    expect(myRoleInTurn(state, 'B', 'cc', 25_000)).toBe('queued');
  });

  it('applyGraceSupplementReply marks Lead skipped_by_grace and continues in delta', () => {
    const r = room();
    const state = { ...newSequentialTurn(r, 1, 1000)!, leadGraceUntil: 1000 + 20_000 };
    const { state: after, leadSkipped } = applyGraceSupplementReply(
      state, 'A', 'cc', r, 25_000,
    );
    expect(leadSkipped).toEqual({
      name: 'Lead', client: 'cc', role: 'lead', status: 'skipped_by_grace', at: 25_000, round: 1,
    });
    expect(after.spoken).toEqual([
      { name: 'Lead', client: 'cc', role: 'lead', status: 'skipped_by_grace', at: 25_000, round: 1 },
      { name: 'A', client: 'cc', role: 'supplement', status: 'replied', at: 25_000, round: 1 },
    ]);
    expect(after.phase).toBe('delta');
    expect(after.currentName).toBe('B');
    expect(after.queue).toEqual([]);
    expect(after.leadGraceUntil).toBeUndefined();
  });

  it('grace path with drained queue advances to converge_draft', () => {
    const r = room({ participants: [part('host', 'web', 0), part('Lead', 'cc', 10), part('A', 'cc', 20)] });
    const state = { ...newSequentialTurn(r, 1, 1000)!, leadGraceUntil: 1000 + 20_000 };
    const { state: after } = applyGraceSupplementReply(state, 'A', 'cc', r, 25_000);
    expect(after.phase).toBe('converge_draft');
    expect(after.currentName).toBe('Lead');
    expect(after.currentRole).toBe('wrap');
    expect(after.queue).toEqual([]);
    expect(after.spoken).toHaveLength(2); // Lead skipped_by_grace + A replied
  });

  it('Lead reply during grace uses normal advanceTurn (no skip)', () => {
    const r = room();
    const state = { ...newSequentialTurn(r, 1, 1000)!, leadGraceUntil: 1000 + 20_000 };
    const after = advanceTurn(state, 'replied', r, 5_000);
    expect(after.spoken[0]?.status).toBe('replied');
    expect(after.phase).toBe('delta');
    expect(after.currentName).toBe('A');
    expect(after.leadGraceUntil).toBeUndefined();
  });

  it('skipQueueHead drops the head supplement without preempting the Lead', () => {
    const r = room();
    const state = { ...newSequentialTurn(r, 1, 1000)!, leadGraceUntil: 1000 + 20_000 };
    const after = skipQueueHead(state, 'no_addition', 25_000);
    expect(after.currentName).toBe('Lead');
    expect(after.currentRole).toBe('lead');
    expect(after.leadGraceUntil).toBe(state.leadGraceUntil);
    expect(after.queue).toEqual([{ name: 'B', client: 'cc', role: 'supplement' }]);
    expect(after.spoken).toEqual([
      { name: 'A', client: 'cc', role: 'supplement', status: 'no_addition', at: 25_000, round: 1 },
    ]);
  });

  it('skipQueueHead is a no-op when the queue is empty', () => {
    const r = room({ participants: [part('host', 'web', 0), part('Lead', 'cc', 10)] });
    const state = newSequentialTurn(r, 1, 1000)!;
    expect(state.queue).toEqual([]);
    const after = skipQueueHead(state, 'no_addition', 25_000);
    expect(after).toEqual(state);
  });
});
