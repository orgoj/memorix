import { describe, it, expect } from 'vitest';
import {
  describeTeamMessage,
  buildTeamEventPayload,
} from '../../src/team/notification-overlay.js';
import type { TeamMessageRow } from '../../src/team/team-store.js';

function message(overrides: Partial<TeamMessageRow> = {}): TeamMessageRow {
  return {
    id: 'msg-1',
    project_id: 'AVIDS2/memorix',
    sender_agent_id: 'sender-1',
    recipient_agent_id: 'recipient-1',
    type: 'request',
    content: 'First line\nFull message body that must stay in durable inbox only',
    payload: null,
    task_id: null,
    read_at: null,
    created_at: 123,
    to_role: null,
    handoff_status: null,
    ...overrides,
  };
}

describe('team notification overlay', () => {
  it('describes first non-empty line only', () => {
    expect(describeTeamMessage('\n  hello world  \nprivate second line')).toBe('hello world');
  });

  it('clips long descriptions with ellipsis', () => {
    const result = describeTeamMessage('   ' + 'x'.repeat(140));
    expect(result.length).toBeLessThanOrEqual(127);
    expect(result.endsWith('…')).toBe(true);
  });

  it('builds team event payload with metadata-only fields', () => {
    const data = buildTeamEventPayload(message({
      content: `   ${'x'.repeat(140)}\nsecond line with private detail`,
    }), { senderName: 'hermes-builder' });

    expect(data.kind).toBe('memorix_team_message');
    expect(data.id).toBe('msg-1');
    expect(data.from).toBe('hermes-builder');
    expect(data.type).toBe('request');
    expect(String(data.description).length).toBeLessThanOrEqual(127);
    expect(String(data.description).endsWith('…')).toBe(true);
    expect(JSON.stringify(data)).not.toContain('Full message body');
    expect(data).not.toHaveProperty('content');
  });

  it('falls back to sender_agent_id when no senderName', () => {
    const data = buildTeamEventPayload(message());
    expect(data.from).toBe('sender-1');
  });
});
