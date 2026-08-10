import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// T-18. Claude Code was dropping out of rooms because detectHarness returned
// 'unknown' — the MCP server is a spawned child and CLAUDECODE /
// CLAUDE_CODE_ENTRYPOINT were not reaching it. 'unknown' falls back to
// state-${ppid}.json, so a Claude Code process (roughly one per turn) read a
// fresh empty state file every time and had no idea it was still in a room.
//
// These assert the shape of the config `init` writes, on source, because the
// installers write to real home-directory paths and the interesting property is
// "which entry goes into which client's file", not the file I/O.
const SRC = readFileSync(join(process.cwd(), 'apps/mcp/src/init.ts'), 'utf8');

describe('T-18: Claude Code self-identifies to the MCP server', () => {
  it('declares CLAUDECODE on the Claude Code entry', () => {
    expect(SRC).toMatch(/const CLAUDE_CODE_MCP_ENTRY = \{[\s\S]*?env: \{ CLAUDECODE: '1' \}[\s\S]*?\};/);
  });

  it('writes that entry into ~/.claude.json', () => {
    const claudeJsonBlock = SRC.slice(SRC.indexOf("join(homedir(), '.claude.json')"));
    expect(claudeJsonBlock.slice(0, 600)).toContain("servers['agent-room'] = CLAUDE_CODE_MCP_ENTRY;");
  });

  // The regression that matters more than the fix: detectHarness checks
  // CLAUDECODE FIRST, so putting the marker on the shared entry would make
  // Cursor / Gemini / Antigravity all report themselves as claude-code.
  it('does NOT put the marker on the entry shared with other clients', () => {
    // Only the object literal — the doc comment below it naturally mentions
    // CLAUDECODE while explaining why the marker must NOT live here.
    const start = SRC.indexOf('const MCP_ENTRY = {');
    const shared = SRC.slice(start, SRC.indexOf('};', start) + 2);
    expect(shared).not.toContain('CLAUDECODE');
    expect(shared).not.toContain('env:');
  });

  it('leaves the other clients writing the unmarked shared entry', () => {
    // Cursor's installer and the printed sample config must still use MCP_ENTRY.
    const cursorBlock = SRC.slice(SRC.indexOf('async function installCursor'));
    expect(cursorBlock.slice(0, 900)).toContain("servers['agent-room'] = MCP_ENTRY;");
  });
});
