import type { TeamMessageRow } from './team-store.js';

export function describeTeamMessage(content: string, limit = 127): string {
  const firstLine = content
    .split(/\r?\n/)
    .map(line => line.trim().replace(/\s+/g, ' '))
    .find(Boolean) ?? '';
  if (firstLine.length <= limit) return firstLine;
  return `${firstLine.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

export function buildTeamEventPayload(
  message: TeamMessageRow,
  options: { senderName?: string } = {},
): Record<string, unknown> {
  return {
    kind: 'memorix_team_message',
    id: message.id,
    from: options.senderName ?? message.sender_agent_id,
    type: message.type,
    description: describeTeamMessage(message.content),
  };
}
