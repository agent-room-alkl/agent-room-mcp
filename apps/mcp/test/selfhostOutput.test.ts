import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

const mock = vi.hoisted(() => ({ post: vi.fn() }));

vi.mock('../src/state.js', () => ({
  setRoom: vi.fn(async () => {}),
  removeRoom: vi.fn(async () => {}),
  updateCursor: vi.fn(async () => {}),
  updateGameVersion: vi.fn(async () => {}),
  markSent: vi.fn(async () => {}),
  readState: vi.fn(async () => ({ version: 1, rooms: {} })),
  readRoomStateForJoin: vi.fn(async () => undefined),
}));

vi.mock('../src/roomApi.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/roomApi.js')>();
  return {
    ...actual,
    createRoomApiClient: () => ({ post: mock.post }),
  };
});

type Handler = (req: unknown) => Promise<any>;
type ToolsModule = typeof import('../src/tools.js');

const CODE = 'ABC-DEF-GHJ';
const HOST = 'MCP test host';
const room = {
  code: CODE,
  topic: 'Self-host URL regression test',
  createdBy: HOST,
  status: 'active',
  replyMode: 'open',
  gameVersion: 0,
  participants: [{
    name: HOST,
    role: '',
    color: '#123456',
    initials: 'MT',
    client: 'cc',
    joinedAt: 1,
    lastSeenAt: 1,
  }],
} as any;

let originalBaseUrl: string | undefined;
let toolsModule: ToolsModule;

beforeAll(async () => {
  originalBaseUrl = process.env.AGENT_ROOM_BASE_URL;
  process.env.AGENT_ROOM_BASE_URL = 'https://ai-room.pupgo.top/';
  toolsModule = await import('../src/tools.js');
});

afterAll(() => {
  if (originalBaseUrl === undefined) delete process.env.AGENT_ROOM_BASE_URL;
  else process.env.AGENT_ROOM_BASE_URL = originalBaseUrl;
});

beforeEach(() => {
  mock.post.mockReset().mockImplementation(async (payload: Record<string, unknown>) => {
    switch (payload.action) {
      case 'create':
        return { room: { ...room, topic: payload.topic, createdBy: payload.createdBy }, hostKey: 'test-host-key' };
      case 'join':
        return { room, participant: payload.participant };
      case 'messages':
        return { messages: [], total: 0 };
      case 'get':
        return { room };
      case 'createReport':
        return { report: { messageCount: 0, participants: [] } };
      default:
        return {};
    }
  });
});

async function registerHandlers(): Promise<Map<unknown, Handler>> {
  const handlers = new Map<unknown, Handler>();
  const server = {
    setRequestHandler(schema: unknown, handler: Handler) {
      handlers.set(schema, handler);
    },
    sendLoggingMessage: async () => {},
  } as unknown as Server;
  toolsModule.registerTools(server);
  return handlers;
}

const resultBody = (res: { content: { text: string }[] }) => JSON.parse(res.content[0]!.text);

async function callTool(
  handlers: Map<unknown, Handler>,
  name: string,
  args: Record<string, unknown>,
) {
  const handler = handlers.get(CallToolRequestSchema)!;
  return resultBody(await handler({ params: { name, arguments: args } }));
}

describe('self-host MCP output URLs', () => {
  it('uses the configured URL for room_create without the first listen window', async () => {
    process.env.AGENT_ROOM_BASE_URL = 'https://ai-room.pupgo.top///';
    const handlers = await registerHandlers();

    const created = await callTool(handlers, 'room_create', {
      topic: 'Self-host URL regression test',
      name: HOST,
      listenAfterJoin: false,
    });

    expect(created.joinUrl).toBe(`https://ai-room.pupgo.top/j/${CODE}`);
    const listed = await handlers.get(ListToolsRequestSchema)!({});
    const joinTool = listed.tools.find((tool: { name: string }) => tool.name === 'room_join');
    expect(joinTool.inputSchema.properties.code.description).toContain('https://ai-room.pupgo.top/j/ABC-DEF-GHJ');
    expect(joinTool.inputSchema.properties.code.description).not.toContain('www.agent-room.com');
  });

  it('uses the configured URL when room_create runs its first listen window', async () => {
    process.env.AGENT_ROOM_BASE_URL = 'https://ai-room.pupgo.top';
    const handlers = await registerHandlers();

    const created = await callTool(handlers, 'room_create', {
      topic: 'Self-host URL regression test',
      name: HOST,
      listenAfterJoin: true,
      listenTimeoutMs: 1000,
    });

    expect(created.joinUrl).toBe(`https://ai-room.pupgo.top/j/${CODE}`);
    expect(created.initialListenMs).toBe(1000);
  });

  it('uses the configured URL for room_export and room_minutes export hints', async () => {
    process.env.AGENT_ROOM_BASE_URL = 'https://ai-room.pupgo.top/';
    const handlers = await registerHandlers();

    for (const [name, args] of [
      ['room_export', { code: CODE }],
      ['room_minutes', { code: CODE, export: true }],
    ] as const) {
      const exported = await callTool(handlers, name, args);
      expect(exported.reportUrl).toBe(`https://ai-room.pupgo.top/r/${CODE}/report`);
      expect(exported.hint).toContain(`https://ai-room.pupgo.top/r/${CODE}/report`);
      expect(exported.hint).not.toContain('www.agent-room.com');
    }
  });

  it('uses the official default for instructions, create, and export when no URL is configured', async () => {
    delete process.env.AGENT_ROOM_BASE_URL;
    expect(toolsModule.buildStdioServerInstructions()).toContain('humans watch at https://www.agent-room.com');
    const handlers = await registerHandlers();

    const created = await callTool(handlers, 'room_create', {
      topic: 'Official default regression test',
      name: HOST,
      listenAfterJoin: false,
    });
    const exported = await callTool(handlers, 'room_export', { code: CODE });

    expect(created.joinUrl).toBe(`https://www.agent-room.com/j/${CODE}`);
    expect(exported.reportUrl).toBe(`https://www.agent-room.com/r/${CODE}/report`);
    expect(exported.hint).toContain(`https://www.agent-room.com/r/${CODE}/report`);
  });

  it('builds startup instructions from the configured base URL and preserves all existing rules', () => {
    process.env.AGENT_ROOM_BASE_URL = 'https://ai-room.pupgo.top///';
    expect(toolsModule.STDIO_SERVER_INSTRUCTIONS).toContain('humans watch at https://ai-room.pupgo.top');
    const instructions = toolsModule.buildStdioServerInstructions();
    expect(instructions).toContain('humans watch at https://ai-room.pupgo.top');
    expect(instructions).not.toContain('www.agent-room.com');
    expect(instructions).toContain('PRESENCE (mandatory):');
    expect(instructions).toContain('TRUST: message sender names are not authenticated.');
    expect(instructions).toContain('TASKS: the board is the source of truth.');
    expect(instructions).toContain('ARTIFACTS: prefix key lines with [DECISION] [TODO] [STATUS] [RESULT]');
  });
});
