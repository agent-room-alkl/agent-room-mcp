import { promises as fs } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { detectHarness, harnessRunId } from './harness.js';

const STATE_DIR = process.env.AGENT_ROOM_STATE_DIR || join(homedir(), '.agent-room');

// Scope state per Claude Code session. The MCP server and the hook command are
// both spawned directly by Claude Code, so they share a parent PID. Two parallel
// sessions on the same machine end up with distinct files — without this, the
// later writer's `name` would clobber the earlier one's, and each session's
// hook would filter the *other* agent's messages as "own" by mistake.
//
// Override with AGENT_ROOM_STATE_FILE to share state across sessions on purpose
// (e.g. integration tests).
const STATE_FILE =
  process.env.AGENT_ROOM_STATE_FILE ||
  join(STATE_DIR, `state-${process.ppid ?? process.pid}.json`);

function currentHarnessStateFile(): string | null {
  if (process.env.AGENT_ROOM_STATE_FILE) return null;
  const kind = detectHarness().kind;
  if (kind !== 'cursor' && kind !== 'codex') return null;
  return join(STATE_DIR, `state-harness-${kind}.json`);
}

export interface RoomState {
  name: string;
  cursor: number;
  joinedAt: number;
  lastSentAt?: number;
  gameVersion?: number;
  // Stored when this MCP session is the host of the room (room_create).
  // Required to claim the host display name on rejoin / reconnect; without
  // it, joinRoom rejects with HostNameTakenError. Plain text on disk under
  // ~/.agent-room/ — same trust level as the MCP state itself.
  hostKey?: string;
  // Codex `session_id` / Cursor `conversation_id` that owns this join.
  // Shared harness state (`state-harness-codex.json` / `state-harness-cursor.json`)
  // is otherwise visible to EVERY thread on that harness — without this key,
  // a Reddit-work Codex chat would keep getting stop-hook room contract
  // injections for a different thread that joined an Agent Room.
  sessionKey?: string;
  // Harness client kind (e.g. 'codex', 'cursor', 'antigravity') that joined the room.
  clientKind?: string;
  // Harness run id (see harnessRunId) of the thread that performed the join,
  // recorded at join time. `clientKind` only partitions by client *type*, so
  // two Codex threads still share a partition; this is what separates them.
  ownerRunId?: string;
}

/**
 * True when this room should receive stop-hook keep-alive for `sessionKey`.
 *
 * Order matters, and it must fail CLOSED once a room has an owner. The first
 * cut of this checked `!sessionKey` first and returned true — "legacy
 * behaviour" — which reopened the exact hole the session key exists to close:
 * a Codex Stop payload that carries no `session_id` resolves to undefined, so
 * an unrelated thread (Robin's Reddit chat, 2026-08-05) kept getting the room
 * contract injected even though the room was demonstrably claimed by another
 * session. A claimed room plus an anonymous caller is not a legacy setup — it
 * is precisely the leak.
 *
 * Genuinely legacy state (joined before sessionKey existed, so `room.sessionKey`
 * is unset) still gets the permissive path and stays claimable.
 *
 * `ownerRunId` is checked BEFORE the claim path, and it is what closes the
 * remaining hole: `clientKind` partitions by client *type*, so two Codex threads
 * land in the same partition and an unclaimed room is still up for grabs by
 * whichever of them reaches Stop first. Binding at join time means the room was
 * never up for grabs. The check only fires when BOTH sides have a run id — a
 * harness that exposes none behaves exactly as before.
 */
export function roomBelongsToSession(
  room: RoomState,
  sessionKey: string | undefined,
): boolean {
  const currentKind = detectHarness().kind;
  if (room.clientKind && room.clientKind !== currentKind) return false;
  const currentRunId = harnessRunId();
  if (room.ownerRunId && currentRunId && room.ownerRunId !== currentRunId) return false;
  if (!room.sessionKey) return true; // unclaimed / pre-sessionKey state; caller may claim it
  if (!sessionKey) return false; // room has an owner and this caller has no identity — not theirs
  return room.sessionKey === sessionKey;
}

export interface AgentRoomState {
  version: 1;
  rooms: Record<string, RoomState>;
  // Number of consecutive Stop-hook blocks since the last UserPromptSubmit.
  // Used to cap autonomous chat back-and-forth so it can't loop forever
  // without the user typing.
  blockStreak?: number;
}

const EMPTY: AgentRoomState = { version: 1, rooms: {}, blockStreak: 0 };

function cloneEmpty(): AgentRoomState {
  return { ...EMPTY, rooms: {} };
}

function isValidState(parsed: AgentRoomState): boolean {
  return parsed.version === 1 && typeof parsed.rooms === 'object' && parsed.rooms !== null;
}

async function readStateFile(file: string): Promise<AgentRoomState> {
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(raw) as AgentRoomState;
    if (!isValidState(parsed)) return cloneEmpty();
    return parsed;
  } catch {
    return cloneEmpty();
  }
}

export async function readState(): Promise<AgentRoomState> {
  return readStateFile(STATE_FILE);
}

/**
 * Pick which of two records for the same room code survives the merge.
 *
 * Recency alone is wrong. Two clients in the same room each write their own
 * state file, and the merged record keeps exactly one `clientKind` — so
 * "newest wins" means the client that joined LAST silently takes ownership of
 * the room record every other client reads, and the earlier client's own room
 * fails its `clientKind` check afterwards. Observed 2026-08-05: a Claude
 * Desktop join 118s after an Antigravity join flipped the shared record to
 * `unknown`, which is also the only reason a Codex thread stopped matching it.
 * Isolation that depends on join order is not isolation.
 *
 * So: a record whose `clientKind` matches the harness doing the read always
 * beats one that does not. Recency only breaks ties within the same kind.
 */
function preferredRoomRecord(a: RoomState, b: RoomState, currentKind: string): RoomState {
  const aMatches = a.clientKind === currentKind;
  const bMatches = b.clientKind === currentKind;
  if (aMatches !== bMatches) return aMatches ? a : b;
  return a.joinedAt >= b.joinedAt ? a : b;
}

export function mergeStates(states: AgentRoomState[]): AgentRoomState {
  const merged = cloneEmpty();
  const currentKind = detectHarness().kind;

  for (const state of states) {
    merged.blockStreak = Math.max(merged.blockStreak ?? 0, state.blockStreak ?? 0);

    for (const [code, room] of Object.entries(state.rooms)) {
      const existing = merged.rooms[code];
      if (!existing) {
        merged.rooms[code] = { ...room };
        continue;
      }

      const winner = preferredRoomRecord(room, existing, currentKind);
      // Identity fields come from the winner ALONE — never `winner.x ?? loser.x`.
      // Grafting a loser's sessionKey / ownerRunId onto the winner would hand
      // the winner an owner it never had, which is the same cross-thread leak
      // one level down.
      merged.rooms[code] = {
        ...winner,
        // Cursors and send timestamps are safe to take the max of: they only
        // guard against replaying messages, and both records saw the room.
        cursor: Math.max(existing.cursor, room.cursor),
        lastSentAt: Math.max(existing.lastSentAt ?? 0, room.lastSentAt ?? 0) || undefined,
        gameVersion: Math.max(existing.gameVersion ?? -1, room.gameVersion ?? -1) >= 0
          ? Math.max(existing.gameVersion ?? -1, room.gameVersion ?? -1)
          : undefined,
        hostKey: winner.hostKey ?? existing.hostKey ?? room.hostKey,
      };
    }
  }

  return merged;
}

async function listStateFiles(): Promise<string[]> {
  if (process.env.AGENT_ROOM_STATE_FILE) return [STATE_FILE];

  let files: string[] = [];
  try {
    const entries = await fs.readdir(STATE_DIR);
    files = entries
      .filter((name) => /^state-(?:\d+|harness-[a-z-]+)\.json$/.test(name))
      .map((name) => join(STATE_DIR, name));
  } catch {
    files = [];
  }

  return Array.from(new Set([...files, STATE_FILE, currentHarnessStateFile()].filter(Boolean) as string[]));
}

export async function readMergedState(): Promise<AgentRoomState> {
  const files = await listStateFiles();
  const states = await Promise.all(files.map(readStateFile));
  return mergeStates(states);
}

export async function readRoomStateForJoin(code: string, desiredName: string): Promise<RoomState | undefined> {
  const current = (await readState()).rooms[code];
  if (current) return current;

  const files = await listStateFiles();
  const states = await Promise.all(files.map(readStateFile));
  return states
    .map((state) => state.rooms[code])
    .filter((room): room is RoomState => Boolean(room && room.name === desiredName))
    .sort((a, b) => b.joinedAt - a.joinedAt)[0];
}

/**
 * State a Cursor / Codex hook should act on.
 *
 * The harness file is the canonical store for those two harnesses: every join
 * under them writes it (see writeState), so "harness file exists but lists no
 * rooms" means this harness genuinely is not in any room — NOT that we should
 * go looking elsewhere.
 *
 * The previous `rooms.length > 0` guard fell through to readMergedState() on an
 * empty harness file, i.e. on every Stop of every Codex thread that is not in a
 * room. That read EVERY client's state file — the exact cross-client leak the
 * harness scope exists to prevent, and it ran before `clientKind` got a chance
 * to filter anything. The merged fallback now only applies to state written
 * before the harness file existed (< 0.26.6), detected by the file's absence.
 */
export async function readHarnessStateOrMerged(): Promise<AgentRoomState> {
  const harnessFile = currentHarnessStateFile();
  if (harnessFile) {
    const exists = await fs
      .access(harnessFile)
      .then(() => true)
      .catch(() => false);
    if (exists) return readStateFile(harnessFile);
  }
  return readMergedState();
}

async function writeStateFile(file: string, state: AgentRoomState): Promise<void> {
  await fs.mkdir(dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  // 0600: the file carries hostKey; don't leave it group/world-readable on
  // shared machines. The tmp file is recreated on every write, so the mode always applies.
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
  await fs.rename(tmp, file);
}

async function writeState(state: AgentRoomState): Promise<void> {
  await writeStateFile(STATE_FILE, state);
  const harnessFile = currentHarnessStateFile();
  if (harnessFile) await writeStateFile(harnessFile, state);
}


// ---- Cross-process state lock ----------------------------------------------
// The MCP server and the Stop/SessionStart hooks are separate processes that
// all read-modify-write the same state files. Without a lock, two concurrent
// writers both read the same snapshot and the second write silently drops the
// first one's update (lost cursor advance → replayed/missed messages; lost
// blockStreak bump → the autonomous-loop cap stops working). `mkdir` is atomic
// on every platform, so an empty lock directory is the mutex; a stale lock
// (holder crashed) is stolen after LOCK_STALE_MS — hook processes live for
// seconds, so 5s is generous.
const LOCK_DIR = join(STATE_DIR, '.state-lock');
const LOCK_STALE_MS = 5_000;
const LOCK_RETRY_MS = 25;
const LOCK_MAX_TRIES = 40; // ~1s worst case, then proceed unlocked

async function acquireStateLock(): Promise<boolean> {
  for (let i = 0; i < LOCK_MAX_TRIES; i++) {
    try {
      await fs.mkdir(LOCK_DIR);
      return true;
    } catch {
      try {
        const st = await fs.stat(LOCK_DIR);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          await fs.rmdir(LOCK_DIR).catch(() => { /* raced another stealer */ });
          continue;
        }
      } catch {
        continue; // lock vanished between mkdir and stat — retry immediately
      }
      await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
    }
  }
  // Never deadlock the user's agent over a stuck lock — worst case we are
  // back to the old (lossy but functional) unlocked behaviour for one call.
  return false;
}

async function withStateLock<T>(fn: () => Promise<T>): Promise<T> {
  await fs.mkdir(STATE_DIR, { recursive: true }).catch(() => { /* readState handles missing dir */ });
  const locked = await acquireStateLock();
  try {
    return await fn();
  } finally {
    if (locked) await fs.rmdir(LOCK_DIR).catch(() => { /* already released */ });
  }
}

export async function setRoom(code: string, room: RoomState): Promise<void> {
  await withStateLock(async () => {
    const state = await readState();
    state.rooms[code] = room;
    await writeState(state);
  });
}

export async function removeRoom(code: string): Promise<void> {
  await withStateLock(async () => {
    const state = await readState();
    if (code in state.rooms) {
      delete state.rooms[code];
      await writeState(state);
    }
  });
}

export async function updateCursor(code: string, cursor: number): Promise<void> {
  await withStateLock(async () => {
    const state = await readState();
    const room = state.rooms[code];
    if (!room) return;
    if (cursor <= room.cursor) return;
    room.cursor = cursor;
    await writeState(state);
  });
}

export async function updateGameVersion(code: string, gameVersion: number): Promise<void> {
  await withStateLock(async () => {
    const state = await readState();
    const room = state.rooms[code];
    if (!room || (room.gameVersion ?? -1) >= gameVersion) return;
    room.gameVersion = gameVersion;
    await writeState(state);
  });
}

export async function updateCursorEverywhere(code: string, cursor: number): Promise<void> {
  await withStateLock(async () => {
    const files = await listStateFiles();
    await Promise.all(files.map(async (file) => {
      const state = await readStateFile(file);
      const room = state.rooms[code];
      if (!room || cursor <= room.cursor) return;
      room.cursor = cursor;
      await writeStateFile(file, state);
    }));
  });
}

export async function markSent(code: string, at: number): Promise<void> {
  await withStateLock(async () => {
    const state = await readState();
    const room = state.rooms[code];
    if (!room) return;
    room.lastSentAt = at;
    await writeState(state);
  });
}

export async function bumpBlockStreak(): Promise<number> {
  return withStateLock(async () => {
    const state = await readState();
    state.blockStreak = (state.blockStreak ?? 0) + 1;
    await writeState(state);
    return state.blockStreak;
  });
}

export async function bumpBlockStreakEverywhere(): Promise<number> {
  return withStateLock(async () => {
    const next = ((await readMergedState()).blockStreak ?? 0) + 1;
    const files = await listStateFiles();
    await Promise.all(files.map(async (file) => {
      const state = await readStateFile(file);
      state.blockStreak = next;
      await writeStateFile(file, state);
    }));
    return next;
  });
}

export async function resetBlockStreak(): Promise<void> {
  await withStateLock(async () => {
    const state = await readState();
    if (!state.blockStreak) return;
    state.blockStreak = 0;
    await writeState(state);
  });
}

export async function resetBlockStreakEverywhere(): Promise<void> {
  await withStateLock(async () => {
    const files = await listStateFiles();
    await Promise.all(files.map(async (file) => {
      const state = await readStateFile(file);
      if (!state.blockStreak) return;
      state.blockStreak = 0;
      await writeStateFile(file, state);
    }));
  });
}

export async function removeRoomEverywhere(code: string): Promise<void> {
  await withStateLock(async () => {
    const files = await listStateFiles();
    await Promise.all(files.map(async (file) => {
      const state = await readStateFile(file);
      if (!(code in state.rooms)) return;
      delete state.rooms[code];
      await writeStateFile(file, state);
    }));
  });
}

/**
 * Stamp `sessionKey` onto a room that has none yet (first Stop after join).
 * Writes across the caller's own state files so harness + PPID copies stay
 * aligned. Returns false if the room is already claimed by someone else.
 *
 * "Everywhere" is deliberately narrower than it used to be. The first version
 * stamped every state file on disk that mentioned the code, so one Stop wrote
 * this session's id into OTHER clients' records for the same room — that is how
 * two different agents ended up sharing one sessionKey. A record belonging to a
 * different client kind, or to a different thread of this kind, is another
 * session's business; skip it and leave it untouched.
 */
export async function claimRoomSessionEverywhere(
  code: string,
  sessionKey: string,
): Promise<boolean> {
  const currentKind = detectHarness().kind;
  const currentRunId = harnessRunId();
  return withStateLock(async () => {
    const files = await listStateFiles();
    let ok = true;
    await Promise.all(files.map(async (file) => {
      const state = await readStateFile(file);
      const room = state.rooms[code];
      if (!room) return;
      // Not ours to stamp — and not a reason to fail the claim either.
      if (room.clientKind && room.clientKind !== currentKind) return;
      if (room.ownerRunId && currentRunId && room.ownerRunId !== currentRunId) return;
      if (room.sessionKey && room.sessionKey !== sessionKey) {
        ok = false;
        return;
      }
      if (room.sessionKey === sessionKey) return;
      room.sessionKey = sessionKey;
      await writeStateFile(file, state);
    }));
    return ok;
  });
}
