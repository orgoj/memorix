import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/embedding/provider.js', () => ({
  getEmbeddingProvider: async () => null,
  isVectorSearchAvailable: async () => false,
  isEmbeddingExplicitlyDisabled: () => true,
  resetProvider: () => {},
}));

vi.mock('../../src/llm/provider.js', () => ({
  initLLM: () => null,
  isLLMEnabled: () => false,
  getLLMConfig: () => null,
  setLLMConfig: () => {},
}));

vi.mock('../../src/config.js', () => ({
  getLLMApiKey: () => null,
  getLLMProvider: () => 'openai',
  getLLMModel: (fallback?: string) => fallback ?? 'gpt-4.1-nano',
  getLLMBaseUrl: (fallback?: string) => fallback ?? 'https://api.openai.com/v1',
}));

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMemorixServer } from '../../src/server.js';
import { resetDb } from '../../src/store/orama-store.js';

function getHandler(server: any, name: string) {
  const handler = server._registeredTools?.[name]?.handler;
  expect(handler).toBeTypeOf('function');
  return handler;
}

function getText(result: any): string {
  return (result?.content ?? [])
    .filter((item: any) => item?.type === 'text')
    .map((item: any) => item.text)
    .join('');
}

function extractAgentId(text: string): string {
  const match = text.match(/\(ID: (\S+)\)/);
  expect(match).toBeTruthy();
  return match![1];
}

async function createGitProjectDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await fs.mkdir(path.join(dir, '.git'));
  return dir;
}

describe('MCP logging notifications', () => {
  it('declares logging capability so sendLoggingMessage emits notifications', async () => {
    const projectRoot = await createGitProjectDir('memorix-logging-capability-');
    await resetDb();

    const { server } = await createMemorixServer(projectRoot, undefined, undefined, { toolProfile: 'team' } as any);
    const notifications: unknown[] = [];
    (server.server as any).notification = async (notification: unknown) => {
      notifications.push(notification);
    };

    await server.server.sendLoggingMessage({
      level: 'info',
      logger: 'memorix.team',
      data: { kind: 'memorix_team_message', id: 'msg-1' },
    });

    expect(notifications).toEqual([
      {
        method: 'notifications/message',
        params: {
          level: 'info',
          logger: 'memorix.team',
          data: { kind: 'memorix_team_message', id: 'msg-1' },
        },
      },
    ]);
  }, 30000);
});

describe('team notification response injection', () => {
  it('appends hint when team agent has unread messages', async () => {
    const projectRoot = await createGitProjectDir('memorix-hint-');
    await resetDb();

    const { server } = await createMemorixServer(projectRoot, undefined, undefined, { toolProfile: 'team' } as any);
    const s = server as any;

    // Join sender first
    const senderResult = await getHandler(s, 'team_manage')({ action: 'join', name: 'sender', agentType: 'test', role: 'worker' });
    const senderId = extractAgentId(getText(senderResult));

    // Join recipient LAST so currentAgentId = recipientId
    const recipientResult = await getHandler(s, 'team_manage')({ action: 'join', name: 'recipient', agentType: 'test', role: 'worker' });
    const recipientId = extractAgentId(getText(recipientResult));

    // Send message from sender to recipient (from param is explicit, doesn't need currentAgentId to be sender)
    await getHandler(s, 'team_message')({ action: 'send', from: senderId, to: recipientId, type: 'request', content: 'Hello colleague' });

    // Recipient (currentAgentId) calls a non-skip tool — should see notification hint
    const searchResult = await getHandler(s, 'memorix_search')({ query: 'test' });
    const resultText = getText(searchResult);

    expect(resultText).toContain('[NOTIFICATION]');
    expect(resultText).toContain('unread team message');
  }, 30000);

  it('skips hint for memorix_poll (already shows inbox)', async () => {
    const projectRoot = await createGitProjectDir('memorix-hint-skip-');
    await resetDb();

    const { server } = await createMemorixServer(projectRoot, undefined, undefined, { toolProfile: 'team' } as any);
    const s = server as any;

    // Join sender
    const senderResult = await getHandler(s, 'team_manage')({ action: 'join', name: 'sender', agentType: 'test', role: 'worker' });
    const senderId = extractAgentId(getText(senderResult));

    // Join recipient last (currentAgentId = recipientId)
    const recipientResult = await getHandler(s, 'team_manage')({ action: 'join', name: 'recipient', agentType: 'test', role: 'worker' });
    const recipientId = extractAgentId(getText(recipientResult));

    // Send message to create unread
    await getHandler(s, 'team_message')({ action: 'send', from: senderId, to: recipientId, type: 'info', content: 'Test msg' });

    // memorix_poll is in TEAM_HINT_SKIP — should NOT have notification hint
    const pollResult = await getHandler(s, 'memorix_poll')({ agentId: recipientId });
    const pollText = getText(pollResult);
    expect(pollText).not.toContain('[NOTIFICATION]');
  }, 30000);
});
