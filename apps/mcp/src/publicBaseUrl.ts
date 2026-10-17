const DEFAULT_BASE_URL = 'https://www.agent-room.com';

export function publicBaseUrl(): string {
  const configured = process.env.AGENT_ROOM_BASE_URL?.trim();
  return (configured || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

export function roomJoinUrl(code: string): string {
  return `${publicBaseUrl()}/j/${code}`;
}

export function roomReportUrl(code: string): string {
  return `${publicBaseUrl()}/r/${code}/report`;
}
