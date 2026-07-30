// setReportVisibility: 'public' must persist the report (drop the TTL) and
// register it for the sitemap; 'link' must restore the 24h expiry and
// de-list it. The fake client records raw Redis commands so the test pins
// the exact TTL semantics, not a re-implementation.

import { describe, expect, it } from 'vitest';
import type { UpstashClient } from '../src/client.js';
import {
  PUBLIC_REPORTS_KEY,
  REPORT_TTL_SECONDS,
  listPublicReportCodes,
  setReportVisibility,
} from '../src/reports.js';

function fakeClient(initial: Record<string, string>) {
  const store = new Map(Object.entries(initial));
  const sets = new Map<string, Set<string>>();
  const commands: (string | number)[][] = [];
  const run = (cmd: readonly (string | number)[]): unknown => {
    commands.push([...cmd]);
    const [op, key, ...args] = cmd.map(String);
    switch (op) {
      case 'GET': return store.get(key) ?? null;
      case 'SET': store.set(key, String(args[0])); return 'OK';
      case 'PERSIST': return store.has(key) ? 1 : 0;
      case 'SADD': {
        const set = sets.get(key) ?? new Set<string>();
        args.forEach(a => set.add(a));
        sets.set(key, set);
        return args.length;
      }
      case 'SREM': {
        const set = sets.get(key);
        args.forEach(a => set?.delete(a));
        return 0;
      }
      case 'SMEMBERS': return [...(sets.get(key) ?? [])];
      default: throw new Error(`unexpected command ${op}`);
    }
  };
  const client: UpstashClient = {
    command: async <T,>(cmd: readonly (string | number)[]) => run(cmd) as T,
    pipeline: async <T,>(cmds: readonly (readonly (string | number)[])[]) => cmds.map(c => run(c)) as T[],
  };
  return { client, commands, sets, store };
}

const CODE = 'ABC-DEF-GHJ';
const baseReport = JSON.stringify({ code: CODE, topic: 't', transcript: [] });

describe('setReportVisibility', () => {
  it('public: persists the key and registers it for the sitemap', async () => {
    const { client, commands, sets } = fakeClient({ [`room-report:${CODE}`]: baseReport });
    const updated = await setReportVisibility(client, CODE, 'public');
    expect(updated?.visibility).toBe('public');
    expect(commands).toContainEqual(['PERSIST', `room-report:${CODE}`]);
    expect(commands.some(c => c[0] === 'SET' && String(c[2]).includes('"visibility":"public"') && !c.includes('EX'))).toBe(true);
    expect(sets.get(PUBLIC_REPORTS_KEY)?.has(CODE)).toBe(true);
    expect(await listPublicReportCodes(client)).toEqual([CODE]);
  });

  it('link: restores the 24h TTL and de-lists it', async () => {
    const { client, commands, sets } = fakeClient({
      [`room-report:${CODE}`]: JSON.stringify({ code: CODE, topic: 't', transcript: [], visibility: 'public' }),
    });
    sets.set(PUBLIC_REPORTS_KEY, new Set([CODE]));
    const updated = await setReportVisibility(client, CODE, 'link');
    expect(updated?.visibility).toBe('link');
    expect(commands.some(c => c[0] === 'SET' && c.includes('EX') && c.includes(REPORT_TTL_SECONDS))).toBe(true);
    expect(sets.get(PUBLIC_REPORTS_KEY)?.has(CODE)).toBe(false);
  });

  it('returns null when no report exists', async () => {
    const { client } = fakeClient({});
    expect(await setReportVisibility(client, CODE, 'public')).toBeNull();
  });
});
