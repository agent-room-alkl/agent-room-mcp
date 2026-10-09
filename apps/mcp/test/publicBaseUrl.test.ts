import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoomApiClient } from '../src/roomApi.js';
import { publicBaseUrl, roomJoinUrl, roomReportUrl } from '../src/publicBaseUrl.js';
import { uploadAgentAttachment } from '../src/uploadAttachment.js';

describe('public base URL', () => {
  let originalBaseUrl: string | undefined;

  beforeEach(() => {
    originalBaseUrl = process.env.AGENT_ROOM_BASE_URL;
    delete process.env.AGENT_ROOM_BASE_URL;
  });

  afterEach(() => {
    if (originalBaseUrl === undefined) delete process.env.AGENT_ROOM_BASE_URL;
    else process.env.AGENT_ROOM_BASE_URL = originalBaseUrl;
    vi.unstubAllGlobals();
  });

  it('uses the official site by default and for empty or whitespace configuration', () => {
    expect(publicBaseUrl()).toBe('https://www.agent-room.com');
    process.env.AGENT_ROOM_BASE_URL = '';
    expect(publicBaseUrl()).toBe('https://www.agent-room.com');
    process.env.AGENT_ROOM_BASE_URL = '  \t ';
    expect(publicBaseUrl()).toBe('https://www.agent-room.com');
  });

  it('uses the configured self-host URL and removes every trailing slash', () => {
    process.env.AGENT_ROOM_BASE_URL = ' https://ai-room.pupgo.top/// ';
    expect(publicBaseUrl()).toBe('https://ai-room.pupgo.top');
    expect(roomJoinUrl('ABC-DEF-GHJ')).toBe('https://ai-room.pupgo.top/j/ABC-DEF-GHJ');
    expect(roomReportUrl('ABC-DEF-GHJ')).toBe('https://ai-room.pupgo.top/r/ABC-DEF-GHJ/report');
  });

  it('routes room API requests through the same normalized base URL', async () => {
    process.env.AGENT_ROOM_BASE_URL = 'https://ai-room.pupgo.top///';
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await createRoomApiClient().post({ action: 'probe' });

    expect(fetchMock).toHaveBeenCalledWith('https://ai-room.pupgo.top/api/room', expect.objectContaining({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    }));
  });

  it('routes attachment uploads through the same normalized base URL', async () => {
    process.env.AGENT_ROOM_BASE_URL = 'https://ai-room.pupgo.top///';
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ url: 'https://files.test/a' }), { status: 201 }));

    await uploadAgentAttachment(
      { name: 'hello.txt', mime: 'text/plain', content_base64: Buffer.from('hello').toString('base64') },
      'ABC-DEF-GHJ',
      { fetch: fetchMock as unknown as typeof fetch },
    );

    expect(fetchMock).toHaveBeenCalledWith('https://ai-room.pupgo.top/api/upload', expect.objectContaining({ method: 'POST' }));
  });
});
