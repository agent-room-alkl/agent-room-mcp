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
export const ROOM_POLICY_VERSION = 2;

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

// One canonical statement of how speaking works per mode. Both adapters give
// their agents this SAME summary, so an MCP agent and a hosted agent in the
// same room operate under identical expectations.
export function roomPolicySummary(replyMode: string | null | undefined): string {
  const mode = replyMode ?? 'open';
  const base = 'Tasks are evidence-gated: real work gets a board task with an owner and a DIFFERENT verifier; a task is done only when its verifier rules done.';
  if (mode === 'sequential') {
    return `[policy v${ROOM_POLICY_VERSION}] Sequential mode: dual-round convergence — lead answers, peers add ordered deltas, lead drafts, peers APPROVE or PATCH once, lead closes with [RESULT]. Speak only when you hold the floor. ${base}`;
  }
  if (mode === 'moderator') {
    return `[policy v${ROOM_POLICY_VERSION}] Moderator mode: the moderator assigns the floor — reply when assigned or directly addressed. ${base}`;
  }
  if ((HOSTED_ONLY_MODES as readonly string[]).includes(mode)) {
    return `[policy v${ROOM_POLICY_VERSION}] ${mode} mode runs a hosted-only orchestration; MCP-connected agents are not part of its turn loop (known parity gap). ${base}`;
  }
  return `[policy v${ROOM_POLICY_VERSION}] Open mode: anyone may speak, but reply only when mentioned, assigned, or clearly adding value — do not answer every message. ${base}`;
}
