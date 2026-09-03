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
    expect(text).toContain('completed tasks are never reasons to stop listening');
    expect(text).toContain('host explicitly tells you to leave');
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

  it('upgrades an older section in place, byte-for-byte outside the fences', async () => {
    // Exactly the shape a user who ran init months ago has on disk: the
    // original unversioned fence, stale text between it, and their own
    // writing on both sides.
    const before = '# My memory\n\nMy own notes above.\n\n';
    const stale =
      '<!-- BEGIN agent-room rules (managed by `npx agent-room-mcp init`) -->\n\n'
      + '## Agent Room — auto-join + listen-loop rule\n\n5 rules that shipped long ago.\n'
      + '\n<!-- END agent-room rules -->';
    const after = '\n\n## Notes I keep below the section\n\n- still mine\n';
    await fs.writeFile(path, before + stale + after, 'utf8');

    const res = await ensureRulesSection(path);
    expect(res.changed).toBe(true);

    const text = await fs.readFile(path, 'utf8');
    // Everything the user wrote survives verbatim, on both sides.
    expect(text.startsWith(before)).toBe(true);
    expect(text.endsWith(after)).toBe(true);
    // The stale body is gone, replaced rather than duplicated.
    expect(text).not.toContain('5 rules that shipped long ago');
    expect((text.match(/BEGIN agent-room rules/g) ?? []).length).toBe(1);
    expect((text.match(/END agent-room rules/g) ?? []).length).toBe(1);
    // And the new text is what actually landed.
    expect(text).toContain('every reply you write MUST end with a tool call');
  });

  it('leaves a file that is already current completely alone', async () => {
    await ensureRulesSection(path);
    const first = await fs.readFile(path, 'utf8');

    const res = await ensureRulesSection(path);
    expect(res.changed).toBe(false);
    expect(await fs.readFile(path, 'utf8')).toBe(first);
  });

  it('carries the turn-mechanics rule into the file', async () => {
    await ensureRulesSection(path);
    const text = await fs.readFile(path, 'utf8');
    expect(text).toContain('A reply with no tool call ends your turn');
    expect(text).toContain('an ended turn is you leaving the room');
    expect(text).toContain('`room_send`, not to your terminal');
  });

  it('creates the parent directory if missing', async () => {
    const nested = join(dir, 'deeply', 'nested', 'CLAUDE.md');
    const res = await ensureRulesSection(nested);
    expect(res.changed).toBe(true);
    const text = await fs.readFile(nested, 'utf8');
    expect(text).toContain('BEGIN agent-room rules');
  });
});
