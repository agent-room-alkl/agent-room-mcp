import type { ArtifactKind, Message, RoomArtifact } from './types.js';

const MARKER_PATTERN = /\[(DECISION|TODO|STATUS|RESULT)\]\s*([^\n]+)/gi;

const KIND_BY_MARKER: Record<string, ArtifactKind> = {
  DECISION: 'decision',
  TODO: 'todo',
  STATUS: 'status',
  RESULT: 'result',
};

export function extractArtifacts(messages: Message[]): RoomArtifact[] {
  const artifacts: RoomArtifact[] = [];

  for (const message of messages) {
    if (message.type !== 'msg') continue;
    let match: RegExpExecArray | null;
    MARKER_PATTERN.lastIndex = 0;

    while ((match = MARKER_PATTERN.exec(message.text))) {
      const marker = match[1]?.toUpperCase();
      const text = match[2]?.trim();
      if (!marker || !text) continue;
      artifacts.push({
        id: `${message.id}-${artifacts.length}`,
        kind: KIND_BY_MARKER[marker] ?? 'status',
        text,
        sourceMessageId: message.id,
        author: message.name,
        time: message.time,
      });
    }
  }

  return artifacts;
}

export function artifactLabel(kind: ArtifactKind): string {
  switch (kind) {
    case 'decision':
      return 'Decision';
    case 'todo':
      return 'Todo';
    case 'status':
      return 'Status';
    case 'result':
      return 'Result';
  }
}
