import { describe, expect, it } from 'vitest';
import { mentionedAgents } from './mentions.js';

const ROSTER = ['Claude', 'GPT', 'DeepSeek', 'Gemini'];

describe('mentionedAgents', () => {
  it('finds a single addressed agent', () => {
    expect(mentionedAgents('@Claude 看下这个', ROSTER)).toEqual(['Claude']);
  });

  it('matches case-insensitively — people type @claude', () => {
    expect(mentionedAgents('@claude can you check this', ROSTER)).toEqual(['Claude']);
    expect(mentionedAgents('@deepseek write it', ROSTER)).toEqual(['DeepSeek']);
  });

  it('returns every mentioned agent, in roster order', () => {
    expect(mentionedAgents('@Gemini and @GPT please compare', ROSTER)).toEqual(['GPT', 'Gemini']);
  });

  // Empty means "not addressed to anyone in particular" — callers wake the whole
  // room, so a plain question still reaches everybody.
  it('is empty for a message with no mention', () => {
    expect(mentionedAgents('Hi', ROSTER)).toEqual([]);
    expect(mentionedAgents('what do you all think?', ROSTER)).toEqual([]);
  });

  // A typo must not silence the room; the caller falls back to everyone.
  it('is empty when the mention matches nobody', () => {
    expect(mentionedAgents('@Claud fix it', ROSTER)).toEqual([]);
    expect(mentionedAgents('@robin ping', ROSTER)).toEqual([]);
  });

  it('handles empty text and an empty roster', () => {
    expect(mentionedAgents('', ROSTER)).toEqual([]);
    expect(mentionedAgents('@Claude', [])).toEqual([]);
  });

  it('matches a mention mid-sentence and with punctuation after it', () => {
    expect(mentionedAgents('can @GPT, review this?', ROSTER)).toEqual(['GPT']);
  });

  it('requires the @ — a bare name is not a mention', () => {
    expect(mentionedAgents('Claude said something earlier', ROSTER)).toEqual([]);
  });
});
