// R3: Playbooks — a room's reusable structure, stored durably per account.
//
// Storage (NO TTL — playbooks are assets, they must outlive the 24h room):
//   playbook:{ownerId}:{id}   JSON Playbook
//   playbooks:{ownerId}       SET of ids owned by this account
//
// Official playbooks are plain data in this module (OFFICIAL_PLAYBOOKS) — no
// Redis, no owner, runnable by everyone including Free. Saving a custom
// playbook is Pro-gated by the API layer, not here.

import type {
  Playbook,
  PlaybookRole,
  PlaybookTaskSeed,
  Room,
  TaskBoard,
} from '@agent-room/shared';
import type { UpstashClient } from './client.js';

export const MAX_PLAYBOOK_ROLES = 8;
export const MAX_PLAYBOOK_TASKS = 20;
export const MAX_PLAYBOOKS_PER_OWNER = 50;

function playbookKey(ownerId: string, id: string): string {
  return `playbook:${ownerId}:${id}`;
}

function ownerIndexKey(ownerId: string): string {
  return `playbooks:${ownerId}`;
}

/** Slug for a playbook name: lowercase alnum + dashes, 1-48 chars. Same name
 *  (→ same slug) overwrites — that's the PRD's "同名覆盖" contract. */
export function playbookIdFromName(name: string): string | null {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return slug || null;
}

/**
 * Snapshot a room + board into a playbook. Pure — callers fetch the inputs.
 * Host (web) participants are kept too: their name/role is part of the
 * structure even though they won't get an MCP join prompt.
 */
export function buildPlaybookFromRoom(
  room: Pick<Room, 'code' | 'topic' | 'participants' | 'replyMode' | 'modeConfig'>,
  board: TaskBoard | null | undefined,
  name: string,
  now: number
): Playbook | null {
  const id = playbookIdFromName(name);
  if (!id) return null;

  const seen = new Set<string>();
  const roles: PlaybookRole[] = [];
  for (const p of room.participants) {
    if (seen.has(p.name)) continue;
    seen.add(p.name);
    roles.push({ name: p.name, role: p.role || 'Participant' });
    if (roles.length >= MAX_PLAYBOOK_ROLES) break;
  }

  const tasks: PlaybookTaskSeed[] = (board?.tasks ?? [])
    .slice(0, MAX_PLAYBOOK_TASKS)
    .map(t => ({
      title: t.title,
      ...(t.dod ? { dod: t.dod } : {}),
      ...(t.owner ? { owner: t.owner } : {}),
      ...(t.verifier ? { verifier: t.verifier } : {}),
    }));

  return {
    id,
    name: name.trim(),
    sourceRoomCode: room.code,
    topic: room.topic,
    ...(room.replyMode ? { replyMode: room.replyMode } : {}),
    ...(room.modeConfig ? { modeConfig: room.modeConfig } : {}),
    roles,
    tasks,
    createdAt: now,
    updatedAt: now,
  };
}

/** Persist under the owner. Overwrites an existing id, keeping its createdAt. */
export async function savePlaybook(
  client: UpstashClient,
  ownerId: string,
  playbook: Playbook
): Promise<Playbook> {
  const existing = await getPlaybook(client, ownerId, playbook.id);
  const stored: Playbook = {
    ...playbook,
    ownerId,
    createdAt: existing?.createdAt ?? playbook.createdAt,
  };
  await client.command(['SET', playbookKey(ownerId, playbook.id), JSON.stringify(stored)]);
  await client.command(['SADD', ownerIndexKey(ownerId), playbook.id]);
  return stored;
}

export async function getPlaybook(
  client: UpstashClient,
  ownerId: string,
  id: string
): Promise<Playbook | null> {
  const raw = await client.command<string | null>(['GET', playbookKey(ownerId, id)]);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Playbook;
  } catch {
    return null;
  }
}

export async function listPlaybooks(client: UpstashClient, ownerId: string): Promise<Playbook[]> {
  const ids = await client.command<string[]>(['SMEMBERS', ownerIndexKey(ownerId)]);
  if (!ids || ids.length === 0) return [];
  const out: Playbook[] = [];
  for (const id of ids.slice(0, MAX_PLAYBOOKS_PER_OWNER)) {
    const pb = await getPlaybook(client, ownerId, id);
    if (pb) out.push(pb);
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function countPlaybooks(client: UpstashClient, ownerId: string): Promise<number> {
  const n = await client.command<number>(['SCARD', ownerIndexKey(ownerId)]);
  return typeof n === 'number' ? n : 0;
}

// ---- Official playbooks -----------------------------------------------------
// Curated from the hosted scenarios' role sheets, with task skeletons that
// make the flow concrete. Free plans can run these; only SAVING custom
// playbooks is Pro. `official: true` + no ownerId marks them read-only.

function official(p: Omit<Playbook, 'createdAt' | 'updatedAt' | 'official'>): Playbook {
  return { ...p, official: true, createdAt: 0, updatedAt: 0 };
}

export const OFFICIAL_PLAYBOOKS: Playbook[] = [
  official({
    id: 'code-review-crew',
    name: 'Code review crew',
    topic: 'Review the latest changes: correctness first, then style.',
    replyMode: 'sequential',
    roles: [
      { name: 'Builder', role: 'Developer', brief: 'Implement fixes for anything the reviewers flag; post diffs as evidence.' },
      { name: 'Reviewer', role: 'Code reviewer', brief: 'Hunt real bugs: wrong logic, missed edge cases, races. Reject with a concrete failure scenario.' },
      { name: 'QA', role: 'QA engineer', brief: 'Run the tests, try to break the change, verify DoD before sign-off.' },
    ],
    tasks: [
      { title: 'Review the diff for correctness bugs', dod: 'Every finding has a concrete failure scenario or is dropped.', owner: 'Reviewer', verifier: 'QA' },
      { title: 'Fix confirmed findings', dod: 'All confirmed findings addressed; tests pass.', owner: 'Builder', verifier: 'Reviewer' },
      { title: 'Regression pass', dod: 'Full test suite green; evidence includes the run output.', owner: 'QA', verifier: 'Reviewer' },
    ],
  }),
  official({
    id: 'docs-sprint',
    name: 'Docs sprint',
    topic: 'Turn what we shipped this week into user-facing docs.',
    replyMode: 'sequential',
    roles: [
      { name: 'Researcher', role: 'Researcher', brief: 'Collect what changed: PRs, release notes, gaps in current docs.' },
      { name: 'Writer', role: 'Technical writer', brief: 'Draft the pages. Short sentences, runnable examples.' },
      { name: 'Editor', role: 'Editor', brief: 'Cut fluff, check every command actually runs, verify DoD.' },
    ],
    tasks: [
      { title: 'Inventory undocumented changes', dod: 'A list of pages to write/update with sources.', owner: 'Researcher', verifier: 'Editor' },
      { title: 'Draft the docs', dod: 'Every page has at least one tested example.', owner: 'Writer', verifier: 'Editor' },
    ],
  }),
  official({
    id: 'decision-debate',
    name: 'Decision debate',
    topic: 'Should we do X? Argue both sides, then decide.',
    replyMode: 'open',
    roles: [
      { name: 'Advocate', role: 'Advocate', brief: 'Make the strongest honest case FOR the proposal.' },
      { name: 'Skeptic', role: 'Skeptic', brief: 'Attack the proposal: risks, costs, what breaks. No strawmen.' },
      { name: 'Judge', role: 'Facilitator', brief: 'Force concrete claims, then write the decision with rationale as [DECISION].' },
    ],
    tasks: [
      { title: 'Write the decision memo', dod: 'One [DECISION] message with the call, the top argument from each side, and revisit conditions.', owner: 'Judge', verifier: 'Skeptic' },
    ],
  }),
];

export function getOfficialPlaybook(id: string): Playbook | null {
  return OFFICIAL_PLAYBOOKS.find(p => p.id === id) ?? null;
}
