import { randomInt } from 'node:crypto';
import { ROOM_TTL_SECONDS } from '@agent-room/shared';
import type { ClientKind } from '@agent-room/shared';
import type { UpstashClient } from './client.js';
import { ConcurrencyError } from './errors.js';

export type GameKind = 'undercover';
export type GamePhase = 'in_progress' | 'ended';
export type GameRole = 'civilian' | 'undercover';

export function playerKey(name: string, client: ClientKind): string { return `${client}:${name}`; }

export interface GamePlayer { name: string; client: ClientKind; role: GameRole; word: string; alive: boolean; }
export interface GameState {
  version: number;
  kind: GameKind;
  phase: GamePhase;
  round: number;
  players: GamePlayer[];
  votes: Record<string, string>;
  lastEliminated?: { name: string; client: ClientKind; role: GameRole };
  winner?: GameRole;
  startedAt: number;
  startedBy: string;
}
export interface GameView {
  kind: GameKind;
  phase: GamePhase;
  round: number;
  version: number;
  you?: { role: GameRole; word: string; alive: boolean };
  players: Array<{ name: string; client: ClientKind; alive: boolean }>;
  winner?: GameRole;
  lastEliminated?: { name: string; client: ClientKind };
}

function gameStateKey(code: string): string { return `game-state:${code}`; }
export async function getGameState(client: UpstashClient, code: string): Promise<GameState | null> {
  const raw = await client.command<string | null>(['GET', gameStateKey(code)]);
  if (raw == null) return null;
  try { return JSON.parse(raw) as GameState; } catch { return null; }
}
export async function setGameState(client: UpstashClient, code: string, state: GameState): Promise<void> {
  await client.command(['SET', gameStateKey(code), JSON.stringify(state), 'EX', ROOM_TTL_SECONDS]);
}
export async function clearGameState(client: UpstashClient, code: string): Promise<void> { await client.command(['DEL', gameStateKey(code)]); }

export async function casGameState(client: UpstashClient, code: string, mutator: (current: GameState | null) => GameState | null): Promise<GameState | null> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await getGameState(client, code);
    let next: GameState | null;
    try { next = mutator(current); } catch (e) {
      if (e instanceof ConcurrencyError) { lastError = e; continue; }
      throw e;
    }
    if (next === null) { if (current !== null) await clearGameState(client, code); return null; }
    await setGameState(client, code, next);
    return next;
  }
  throw lastError instanceof ConcurrencyError ? lastError : new ConcurrencyError();
}

export function dealUndercoverGame(participants: Array<{ name: string; client: ClientKind }>, civilianWord: string, undercoverWord: string, pickUndercoverIndex: number, startedBy: string, now: number): GameState {
  if (participants.length < 3) throw new Error('undercover needs at least 3 players');
  if (pickUndercoverIndex < 0 || pickUndercoverIndex >= participants.length) throw new Error('pickUndercoverIndex out of range');
  return {
    version: 1, kind: 'undercover', phase: 'in_progress', round: 1, votes: {}, startedAt: now, startedBy,
    players: participants.map((p, i) => ({ ...p, role: i === pickUndercoverIndex ? 'undercover' : 'civilian', word: i === pickUndercoverIndex ? undercoverWord : civilianWord, alive: true })),
  };
}
export async function startUndercoverGame(client: UpstashClient, code: string, participants: Array<{ name: string; client: ClientKind }>, civilianWord: string, undercoverWord: string, startedBy: string): Promise<GameState> {
  const pick = randomInt(participants.length);
  const state = await casGameState(client, code, () => dealUndercoverGame(participants, civilianWord, undercoverWord, pick, startedBy, Date.now()));
  if (!state) throw new Error('failed to start game');
  return state;
}

export function castVote(state: GameState, voter: string, target: string): GameState {
  if (state.phase !== 'in_progress') throw new Error('game is not in progress');
  const v = state.players.find((p) => playerKey(p.name, p.client) === voter);
  const t = state.players.find((p) => playerKey(p.name, p.client) === target);
  if (!v || !v.alive) throw new Error('voter is not an alive player');
  if (!t || !t.alive) throw new Error('target is not an alive player');
  if (voter === target) throw new Error('cannot vote for yourself');
  return { ...state, version: state.version + 1, votes: { ...state.votes, [voter]: target } };
}
export function checkWinner(state: GameState): GameState {
  const alive = state.players.filter((p) => p.alive);
  if (!alive.some((p) => p.role === 'undercover')) return { ...state, phase: 'ended', winner: 'civilian' };
  if (alive.length <= 2) return { ...state, phase: 'ended', winner: 'undercover' };
  return state;
}
export function tallyRound(state: GameState): GameState {
  if (state.phase !== 'in_progress') return state;
  const alive = state.players.filter((p) => p.alive);
  if (alive.some((p) => !(playerKey(p.name, p.client) in state.votes))) return state;
  const tally = new Map<string, number>();
  for (const target of Object.values(state.votes)) tally.set(target, (tally.get(target) ?? 0) + 1);
  let max = -1; let eliminatedKey: string | undefined; let tied = false;
  for (const [key, count] of tally) { if (count > max) { max = count; eliminatedKey = key; tied = false; } else if (count === max) tied = true; }
  let players = state.players; let lastEliminated: GameState['lastEliminated'];
  if (eliminatedKey && !tied) {
    players = state.players.map((p) => playerKey(p.name, p.client) === eliminatedKey ? { ...p, alive: false } : p);
    const e = state.players.find((p) => playerKey(p.name, p.client) === eliminatedKey)!;
    lastEliminated = { name: e.name, client: e.client, role: e.role };
  }
  return checkWinner({ ...state, version: state.version + 1, players, votes: {}, round: state.round + 1, lastEliminated });
}
export function viewForPlayer(state: GameState, viewerName: string, viewerClient: ClientKind): GameView {
  const you = state.players.find((p) => playerKey(p.name, p.client) === playerKey(viewerName, viewerClient));
  return {
    kind: state.kind, phase: state.phase, round: state.round, version: state.version,
    you: you ? { role: you.role, word: you.word, alive: you.alive } : undefined,
    players: state.players.map((p) => ({ name: p.name, client: p.client, alive: p.alive })),
    winner: state.winner,
    lastEliminated: state.lastEliminated ? { name: state.lastEliminated.name, client: state.lastEliminated.client } : undefined,
  };
}
