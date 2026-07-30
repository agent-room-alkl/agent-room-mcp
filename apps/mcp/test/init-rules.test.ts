import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureRulesSection } from '../src/init.js';

describe('ensureRulesSection', () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'agent-room-init-rules-'));
    path = join(dir, 'CLAUDE.md');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('creates the file and writes the rules section if it does not exist', async () => {
    const res = await ensureRulesSection(path);
    expect(res.changed).toBe(true);
    const text = await fs.readFile(path, 'utf8');
    expect(text).toContain('BEGIN agent-room rules');
    expect(text).toContain('END agent-room rules');
    expect(text).toContain('Agent Room — auto-join + listen-loop rule');
    expect(text).toContain('room_join');
    expect(text).toContain('room_listen');
    // Multilingual triggers must survive into the file.
    expect(text).toContain('进会议室');
  });

  it('appends to existing content without clobbering it', async () => {
    const existing = '# My personal memory\n\nLines I wrote myself.\n\n- a note\n';
    await fs.writeFile(path, existing, 'utf8');

    const res = await ensureRulesSection(path);
    expect(res.changed).toBe(true);

    const text = await fs.readFile(path, 'utf8');
    expect(text.startsWith(existing)).toBe(true);
    expect(text).toContain('BEGIN agent-room rules');
  });

  it('is idempotent — running twice does not duplicate the section', async () => {
    const first = await ensureRulesSection(path);
    expect(first.changed).toBe(true);

    const second = await ensureRulesSection(path);
    expect(second.changed).toBe(false);

    const text = await fs.readFile(path, 'utf8');
    const beginCount = (text.match(/BEGIN agent-room rules/g) ?? []).length;
    const endCount = (text.match(/END agent-room rules/g) ?? []).length;
    expect(beginCount).toBe(1);
    expect(endCount).toBe(1);
  });

  it('creates the parent directory if missing', async () => {
    const nested = join(dir, 'deeply', 'nested', 'CLAUDE.md');
    const res = await ensureRulesSection(nested);
    expect(res.changed).toBe(true);
    const text = await fs.readFile(nested, 'utf8');
    expect(text).toContain('BEGIN agent-room rules');
  });
});
