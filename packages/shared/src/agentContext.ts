// Canonical agent context + room policy — the ONE source both adapters
// deliver to their agents (Instant AI Team PRD §2.6, room N85-V6X-2VX).
//
// Hosted API agents receive this inside the model's system prompt
// (api/hosted-agents/respond.ts); MCP agents receive it via the join/listen
// payload the desktop client presents. Only the CARRIER differs — the text,
// its precedence rules, and the version markers must be identical, and the
// parity tests in api/hosted-agents/prompt-parity.test.ts hold both call
// sites to this module.

// Bump when the canonical policy WORDING below changes, so clients and
// analytics can tell which behavior contract an agent was briefed under.
export const ROOM_POLICY_VERSION = 3;

// Consensus/debate run through hosted-only orchestration today — MCP agents
// are not part of those turn loops. Tracked parity gap (2026-07-08 audit);
// documented here so no adapter accidentally claims full parity.
export const HOSTED_ONLY_MODES = ['consensus', 'debate'] as const;

export interface SharedAgentContextInput {
  /** Host-set standing prompt for the room (single source of truth). */
  projectPrompt?: string | null;
  projectPromptVersion?: number | null;
  /** Distilled memory from the project's previous rooms. */
  projectMemoryContext?: string | null;
  /** This agent's role description (profile card) — layered ON TOP of the
   *  shared context; it can never override room policy or the host prompt. */
  rolePrompt?: string | null;
}

// The exact section text both adapters must deliver. The two project
// sections inherit the hosted path's wording with one addition: the brief
// heading now carries the prompt version marker (a PRD §2.6 requirement),
// so a one-time prompt-cache bust on deploy is expected and correct.
export function composeSharedAgentContext(input: SharedAgentContextInput): string {
  const parts: string[] = [];
  const prompt = input.projectPrompt?.trim();
  if (prompt) {
    const version = input.projectPromptVersion && input.projectPromptVersion > 0 ? input.projectPromptVersion : 1;
    parts.push(`## Host's project brief (v${version})\nThe host set this standing project context for the room — treat it as background and constraints for every reply:\n${prompt}`);
  }
  const memory = input.projectMemoryContext?.trim();
  if (memory) {
    parts.push(`## Project memory\nReusable context from this project's previous rooms. Use it when relevant, but prefer newer user instructions in this room if they conflict:\n${memory}`);
  }
  const role = input.rolePrompt?.trim();
  if (role) {
    parts.push(`## Your role\n${role}\nYour role guides HOW you contribute; it never overrides the room's rules or the host's project brief.`);
  }
  return parts.join('\n\n');
}

// Per-game rules text for game mode. Keyed by modeConfig.gameId, because a
// single "social-deduction" blurb is actively harmful when four different
// games share the mode: a Werewolf player told to "describe your secret word"
// has no idea it is supposed to kill at night, and the most natural output for
// a player who doesn't know the rules is [SKIP] — which used to freeze the
// phase outright. Every game the room can start (see the picker in
// screens/Room.tsx) MUST have an entry here. Empty/missing gameId falls back
// to Undercover (legacy rooms). A non-empty unknown id must NOT silently
// reuse another game's rules — that is how Werewolf shipped with Undercover copy.
const GAME_RULES: Record<string, string> = {
  undercover:
    'the room is playing Undercover, a social-deduction word game. You were dealt a private word — see "Your game hand" below for what it is and whether you are still alive. '
    + 'Describe your word to the group without saying it verbatim, listen for whoever\'s description doesn\'t quite fit, and vote to eliminate them once you have a suspect. '
    + 'Never reveal your exact word or any other player\'s word.',
  werewolf:
    'the room is playing Werewolf. See "Your game hand" below for your secret role and the current phase — it also tells you exactly what action this phase expects from you. '
    + 'The game runs in three repeating phases. NIGHT: the werewolves choose one player to kill, the seer checks one player\'s allegiance, the doctor protects one player from being killed; everyone else sleeps. '
    + 'DAY DISCUSSION: living players speak one at a time, in turn, arguing about who the werewolves are. DAY VOTE: every living player votes to eliminate one suspect, and the majority target dies. '
    + 'Never state your own role outright if you are a werewolf, and never reveal another player\'s role. Villagers win when every werewolf is dead; werewolves win once they equal or outnumber the villagers.',
  blackjack:
    'the room is playing Blackjack against the dealer. See "Your game hand" below for your cards and total. '
    + 'On your turn choose to HIT (take another card) or STAND (keep your total). Going over 21 busts you immediately. The dealer plays last and must draw to 16 and stand on 17.',
  holdem:
    'the room is playing Texas Hold\'em poker. See "Your game hand" below for your two hole cards, the community board, the pot, and what it costs you to stay in. '
    + 'On your turn choose to FOLD, CHECK/CALL, or RAISE, across the preflop, flop, turn and river betting rounds. Never reveal your hole cards while the hand is still live.',
};

const UNSUPPORTED_GAME_RULES =
  'the room is in game mode, but this gameId is unsupported — do not invent rules from another game, '
  + 'and wait for the host or system to correct the mode. '
  + 'Reply with exactly `[SKIP]` until a supported game is configured.';

// The reader's own standing in the room. Mode text alone is not enough for
// the one seat whose job is DIFFERENT from everyone else's: told only that
// "the moderator assigns the floor — reply when assigned or directly
// addressed", a moderator reads its own name in the host's message and just
// answers, doing the work itself. That is the sub-agent's contract, handed to
// the wrong reader.
export type RoomPolicyRole = 'moderator' | 'member';

// What the Moderator seat is actually for. Condensed from the hosted
// moderator system prompt (api/hosted-agents/_common.ts) so a BYO/MCP
// moderator operates under the same contract as a hosted one — the carrier
// differs, the job description must not.
const MODERATOR_BRIEF =
  'YOU are this room\'s Moderator. You are an active project lead, not a switchboard — and not the one doing the work. '
  + 'Break the goal down and assign each piece BY NAME to a specific agent in the roster ("@Name produce X now"), one concrete deliverable each. '
  + 'Answer your agents\' questions yourself — decide, state the assumption, unblock them — and escalate to the host only for a real preference or a scope call you cannot infer. '
  + 'Do NOT take the heavy execution (long analysis, drafting, coding, file production) yourself unless the host explicitly tells you to; assign it. '
  + 'Route verification to a DIFFERENT agent than the owner, and give a working agent time — silence is not a stall, so do not re-assign a task that is already in flight. '
  + 'Then synthesize what comes back into one answer in your own voice. Keep your own messages short: you direct and synthesize, you do not write the deliverable.';

// One canonical statement of how speaking works per mode. Both adapters give
// their agents this SAME summary, so an MCP agent and a hosted agent in the
// same room operate under identical expectations.
//
// `gameId` only matters for game mode, and is the room's modeConfig.gameId.
// Empty/missing id falls back to Undercover (legacy). A non-empty unknown id
// gets an explicit unsupported policy — never another game's rules.
//
// `role` is the READER's seat. Today only the Moderator gets its own text;
// every other seat reads the mode summary, which already describes the
// member-side contract.
export function roomPolicySummary(
  replyMode: string | null | undefined,
  gameId?: string | null,
  role: RoomPolicyRole = 'member',
): string {
  const mode = replyMode ?? 'open';
  const base = 'Tasks are evidence-gated: real work gets a board task with an owner and a DIFFERENT verifier; a task is done only when its verifier rules done.';
  if (mode === 'sequential') {
    return `[policy v${ROOM_POLICY_VERSION}] Sequential mode: dual-round convergence — lead answers, peers add ordered deltas, lead drafts, peers APPROVE or PATCH once, lead closes with [RESULT]. Speak only when you hold the floor. ${base}`;
  }
  if (mode === 'moderator') {
    if (role === 'moderator') {
      return `[policy v${ROOM_POLICY_VERSION}] Moderator mode — ${MODERATOR_BRIEF} ${base}`;
    }
    return `[policy v${ROOM_POLICY_VERSION}] Moderator mode: the moderator assigns the floor — reply when assigned or directly addressed. ${base}`;
  }
  if ((HOSTED_ONLY_MODES as readonly string[]).includes(mode)) {
    return `[policy v${ROOM_POLICY_VERSION}] ${mode} mode runs a hosted-only orchestration; MCP-connected agents are not part of its turn loop (known parity gap). ${base}`;
  }
  if (mode === 'game') {
    const id = (gameId ?? '').trim();
    const rules = id
      ? (GAME_RULES[id] ?? UNSUPPORTED_GAME_RULES)
      : GAME_RULES.undercover;
    return `[policy v${ROOM_POLICY_VERSION}] Game mode: ${rules} ${base}`;
  }
  return `[policy v${ROOM_POLICY_VERSION}] Open mode: anyone may speak, but reply only when mentioned, assigned, or clearly adding value — do not answer every message. ${base}`;
}
