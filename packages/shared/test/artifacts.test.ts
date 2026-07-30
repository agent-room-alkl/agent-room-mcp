import { describe, expect, it } from 'vitest';
import { extractArtifacts, type Message } from '../src/index.js';

const baseMessage: Message = {
  id: 1000,
  type: 'msg',
  name: 'Robin',
  initials: 'RO',
  color: '#000000',
  role: 'host',
  client: 'web',
  text: '',
  time: 1000,
};

describe('extractArtifacts', () => {
  it('extracts supported delivery markers from messages', () => {
    const artifacts = extractArtifacts([
      {
        ...baseMessage,
        text: '[DECISION] Ship the report flow first\n[TODO] Add markdown export',
      },
    ]);

    expect(artifacts).toMatchObject([
      { kind: 'decision', text: 'Ship the report flow first', author: 'Robin' },
      { kind: 'todo', text: 'Add markdown export', author: 'Robin' },
    ]);
  });

  it('ignores system messages and unmarked text', () => {
    const artifacts = extractArtifacts([
      { ...baseMessage, type: 'sys', text: '[RESULT] Hidden' },
      { ...baseMessage, id: 1001, text: 'Plain discussion' },
    ]);

    expect(artifacts).toEqual([]);
  });
});
