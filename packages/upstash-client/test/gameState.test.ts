import { describe, expect, it } from 'vitest';
import { castVote, checkWinner, dealUndercoverGame, playerKey, tallyRound, viewForPlayer } from '../src/gameState.js';

const players = ['A', 'B', 'C', 'D'].map((name) => ({ name, client: 'cc' as const }));

describe('undercover game referee', () => {
  it('deals exactly one private undercover role', () => {
    const state = dealUndercoverGame(players, 'apple', 'pear', 2, 'host', 1);
    expect(state.players.filter((p) => p.role === 'undercover')).toHaveLength(1);
    expect(state.players[2]!.word).toBe('pear');
    expect(viewForPlayer(state, 'A', 'cc').players[2]).not.toHaveProperty('role');
    expect(viewForPlayer(state, 'A', 'cc').players[2]).not.toHaveProperty('word');
  });

  it('requires all alive players before tallying and eliminates plurality target', () => {
    let state = dealUndercoverGame(players, 'a', 'b', 2, 'host', 1);
    state = castVote(state, playerKey('A', 'cc'), playerKey('C', 'cc'));
    expect(tallyRound(state)).toBe(state);
    state = castVote(state, playerKey('B', 'cc'), playerKey('C', 'cc'));
    state = castVote(state, playerKey('C', 'cc'), playerKey('D', 'cc'));
    state = castVote(state, playerKey('D', 'cc'), playerKey('C', 'cc'));
    const next = tallyRound(state);
    expect(next.players.find((p) => p.name === 'C')!.alive).toBe(false);
    expect(next.winner).toBe('civilian');
  });

  it('rejects self-votes and declares undercover win at parity', () => {
    const state = dealUndercoverGame(players, 'a', 'b', 0, 'host', 1);
    expect(() => castVote(state, playerKey('A', 'cc'), playerKey('A', 'cc'))).toThrow(/yourself/);
    const ended = checkWinner({ ...state, players: state.players.map((p) => p.name === 'C' || p.name === 'D' ? { ...p, alive: false } : p) });
    expect(ended.winner).toBe('undercover');
  });
});
