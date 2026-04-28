/**
 * TeamStore - SQLite-backed autonomous Agent Team store tests.
 *
 * Covers: agent registration, messages, atomic task claims, locks,
 * cross-process safety, and team-state.json migration.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TeamStore } from '../../src/team/team-store.js';
import { closeDatabase } from '../../src/store/sqlite-db.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'memorix-team-test-'));
}

function cleanup(dir: string): void {
  closeDatabase(dir);
  fs.rmSync(dir, { recursive: true, force: true });
}

describe('TeamStore', () => {
  let store: TeamStore;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = makeTmpDir();
    store = new TeamStore();
    await store.init(tmpDir);
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // ═════════════════════════════════════════════════════════════════
  // Agent Registration
  // ═════════════════════════════════════════════════════════════════

  describe('Agent Registration', () => {
    it('should register a new agent and return stable agent_id', async () => {
      const agent = store.registerAgent({
        projectId: 'proj1',
        agentType: 'windsurf',
        instanceId: 'inst-1',
        name: 'Cascade',
      });
      expect(agent.agent_id).toBeTruthy();
      expect(agent.agent_type).toBe('windsurf');
      expect(agent.instance_id).toBe('inst-1');
      expect(agent.name).toBe('Cascade');
      expect(agent.status).toBe('active');
    });

    it('should reactivate existing agent by (project_id, agent_type, instance_id)', async () => {
      const first = store.registerAgent({
        projectId: 'proj1',
        agentType: 'windsurf',
        instanceId: 'inst-1',
        name: 'Cascade',
      });
      // Simulate leave
      store.leaveAgent(first.agent_id);

      const second = store.registerAgent({
        projectId: 'proj1',
        agentType: 'windsurf',
        instanceId: 'inst-1',
        name: 'Cascade v2', // name can change
      });

      expect(second.agent_id).toBe(first.agent_id); // same durable identity
      expect(second.name).toBe('Cascade v2');
      expect(second.status).toBe('active');
    });

    it('should NOT merge two agents with same type+name but different instance_id', async () => {
      const a = store.registerAgent({
        projectId: 'proj1',
        agentType: 'windsurf',
        instanceId: 'window-1',
        name: 'Cascade',
      });
      const b = store.registerAgent({
        projectId: 'proj1',
        agentType: 'windsurf',
        instanceId: 'window-2',
        name: 'Cascade', // same name!
      });

      expect(a.agent_id).not.toBe(b.agent_id); // distinct identities
      expect(store.getActiveCount('proj1')).toBe(2);
    });

    it('should auto-generate instance_id when not provided', async () => {
      const agent = store.registerAgent({
        projectId: 'proj1',
        agentType: 'cursor',
      });
      expect(agent.instance_id).toBeTruthy();
      expect(agent.instance_id.length).toBeGreaterThan(10); // UUID
    });

    it('should list agents filtered by status', async () => {
      const a = store.registerAgent({ projectId: 'proj1', agentType: 'windsurf', instanceId: 'i1' });
      store.registerAgent({ projectId: 'proj1', agentType: 'cursor', instanceId: 'i2' });
      store.leaveAgent(a.agent_id);

      const active = store.listAgents('proj1', { status: 'active' });
      const inactive = store.listAgents('proj1', { status: 'inactive' });
      expect(active.length).toBe(1);
      expect(inactive.length).toBe(1);
      expect(inactive[0].agent_id).toBe(a.agent_id);
    });

    it('should update heartbeat', async () => {
      const agent = store.registerAgent({ projectId: 'proj1', agentType: 'windsurf', instanceId: 'i1' });
      const before = store.getAgent(agent.agent_id)!.last_heartbeat;

      // Small delay to ensure different timestamp
      await new Promise(r => setTimeout(r, 15));
      store.heartbeat(agent.agent_id);

      const after = store.getAgent(agent.agent_id)!.last_heartbeat;
      expect(after).toBeGreaterThanOrEqual(before);
    });

    it('should detect and mark stale agents', async () => {
      const agent = store.registerAgent({ projectId: 'proj1', agentType: 'windsurf', instanceId: 'i1' });
      // Force old heartbeat
      store.getDb().prepare('UPDATE team_agents SET last_heartbeat = ? WHERE agent_id = ?')
        .run(Date.now() - 60000, agent.agent_id);

      const stale = store.detectAndMarkStale('proj1', 30000); // 30s threshold
      expect(stale).toContain(agent.agent_id);

      const updated = store.getAgent(agent.agent_id)!;
      expect(updated.status).toBe('inactive');
    });
  });

  // ═════════════════════════════════════════════════════════════════
  // Messages
  // ═════════════════════════════════════════════════════════════════

  describe('Messages', () => {
    let agentA: string;
    let agentB: string;

    beforeEach(() => {
      agentA = store.registerAgent({ projectId: 'proj1', agentType: 'windsurf', instanceId: 'a' }).agent_id;
      agentB = store.registerAgent({ projectId: 'proj1', agentType: 'cursor', instanceId: 'b' }).agent_id;
    });

    it('should send direct message and appear in recipient inbox', () => {
      store.sendMessage({
        projectId: 'proj1',
        senderAgentId: agentA,
        recipientAgentId: agentB,
        type: 'direct',
        content: 'Hello B',
      });

      const inbox = store.getInbox('proj1', agentB);
      expect(inbox.length).toBe(1);
      expect(inbox[0].content).toBe('Hello B');
      expect(inbox[0].sender_agent_id).toBe(agentA);
    });

    it('should deliver broadcast messages to all agents', () => {
      store.sendMessage({
        projectId: 'proj1',
        senderAgentId: agentA,
        recipientAgentId: null,
        type: 'broadcast',
        content: 'Hello everyone',
      });

      const inboxA = store.getInbox('proj1', agentA);
      const inboxB = store.getInbox('proj1', agentB);
      // Broadcast is visible to both (including sender)
      expect(inboxA.length).toBe(1);
      expect(inboxB.length).toBe(1);
    });

    it('should accept messages to inactive recipients (durable messaging)', () => {
      store.leaveAgent(agentB);

      // This must NOT throw — key fix for F6
      const msg = store.sendMessage({
        projectId: 'proj1',
        senderAgentId: agentA,
        recipientAgentId: agentB,
        type: 'handoff',
        content: 'Handoff context',
        payload: { summary: 'Done task X', nextSteps: ['Continue Y'] },
      });
      if ('error' in msg) throw new Error(msg.error);
      expect(msg.id).toBeTruthy();

      // When B comes back, it can read the message
      const inbox = store.getInbox('proj1', agentB);
      expect(inbox.length).toBe(1);
      expect(inbox[0].type).toBe('handoff');
    });

    it('should track read status', () => {
      store.sendMessage({
        projectId: 'proj1',
        senderAgentId: agentA,
        recipientAgentId: agentB,
        type: 'direct',
        content: 'Read me',
      });

      expect(store.getUnreadCount('proj1', agentB)).toBe(1);

      const inbox = store.getInbox('proj1', agentB);
      store.markMessageRead(inbox[0].id);

      expect(store.getUnreadCount('proj1', agentB)).toBe(0);
    });

    it('should prune read messages', async () => {
      const msg = store.sendMessage({
        projectId: 'proj1',
        senderAgentId: agentA,
        recipientAgentId: agentB,
        type: 'direct',
        content: 'Old message',
      });
      if ('error' in msg) throw new Error(msg.error);

      store.markMessageRead(msg.id);

      // Small delay so read_at is strictly in the past
      await new Promise(r => setTimeout(r, 15));

      // Prune messages read more than 0ms ago
      const pruned = store.pruneReadMessages('proj1', 0);
      expect(pruned).toBe(1);
      expect(store.getInbox('proj1', agentB).length).toBe(0);
    });

    it('should reject message from unknown sender', () => {
      const result = store.sendMessage({
        projectId: 'proj1',
        senderAgentId: 'nonexistent-agent',
        recipientAgentId: agentB,
        type: 'direct',
        content: 'Fake message',
      });
      expect('error' in result).toBe(true);
      if ('error' in result) {
        expect(result.error).toContain('Sender agent');
        expect(result.error).toContain('not found');
      }
    });

    it('should reject message to unknown recipient', () => {
      const result = store.sendMessage({
        projectId: 'proj1',
        senderAgentId: agentA,
        recipientAgentId: 'nonexistent-agent',
        type: 'direct',
        content: 'Fake message',
      });
      expect('error' in result).toBe(true);
      if ('error' in result) {
        expect(result.error).toContain('Recipient agent');
        expect(result.error).toContain('not found');
      }
    });

    it('should allow broadcast with null recipient (no validation needed)', () => {
      const result = store.sendMessage({
        projectId: 'proj1',
        senderAgentId: agentA,
        recipientAgentId: null,
        type: 'announcement',
        content: 'Broadcast message',
      });
      if ('error' in result) throw new Error(result.error);
      expect(result.id).toBeTruthy();
    });
  });

  // ═════════════════════════════════════════════════════════════════
  // Tasks — Atomic Claim Semantics
  // ═════════════════════════════════════════════════════════════════

  describe('Tasks', () => {
    let agentA: string;
    let agentB: string;

    beforeEach(() => {
      agentA = store.registerAgent({ projectId: 'proj1', agentType: 'windsurf', instanceId: 'a' }).agent_id;
      agentB = store.registerAgent({ projectId: 'proj1', agentType: 'cursor', instanceId: 'b' }).agent_id;
    });

    it('should create and claim a task', () => {
      const task = store.createTask({ projectId: 'proj1', description: 'Fix bug' });
      const result = store.claimTask(task.task_id, agentA);
      expect(result.success).toBe(true);
      expect(result.task?.assignee_agent_id).toBe(agentA);
      expect(result.task?.status).toBe('in_progress');
    });

    it('should reject claim when task already claimed by another agent', () => {
      const task = store.createTask({ projectId: 'proj1', description: 'Fix bug' });
      store.claimTask(task.task_id, agentA);
      const result = store.claimTask(task.task_id, agentB);
      expect(result.success).toBe(false);
      expect(result.reason).toContain('already claimed');
    });

    it('should allow same agent to re-claim (idempotent)', () => {
      const task = store.createTask({ projectId: 'proj1', description: 'Fix bug' });
      store.claimTask(task.task_id, agentA);
      const result = store.claimTask(task.task_id, agentA);
      expect(result.success).toBe(true);
    });

    it('should reject claim when dependencies are unmet', () => {
      const dep = store.createTask({ projectId: 'proj1', description: 'Dep task' });
      const task = store.createTask({ projectId: 'proj1', description: 'Main task', deps: [dep.task_id] });

      const result = store.claimTask(task.task_id, agentA);
      expect(result.success).toBe(false);
      expect(result.reason).toContain('unmet');
    });

    it('should allow claim after dependencies are completed', () => {
      const dep = store.createTask({ projectId: 'proj1', description: 'Dep task' });
      const task = store.createTask({ projectId: 'proj1', description: 'Main task', deps: [dep.task_id] });

      store.claimTask(dep.task_id, agentA);
      store.completeTask(dep.task_id, agentA, 'Done');

      const result = store.claimTask(task.task_id, agentB);
      expect(result.success).toBe(true);
    });

    it('should complete task atomically', () => {
      const task = store.createTask({ projectId: 'proj1', description: 'Fix bug' });
      store.claimTask(task.task_id, agentA);

      const result = store.completeTask(task.task_id, agentA, 'Fixed');
      expect(result.success).toBe(true);

      const updated = store.getTask(task.task_id)!;
      expect(updated.status).toBe('completed');
      expect(updated.result).toBe('Fixed');
    });

    it('should reject complete by non-assignee', () => {
      const task = store.createTask({ projectId: 'proj1', description: 'Fix bug' });
      store.claimTask(task.task_id, agentA);

      const result = store.completeTask(task.task_id, agentB, 'I did it');
      expect(result.success).toBe(false);
    });

    it('should release task and make it available again', () => {
      const task = store.createTask({ projectId: 'proj1', description: 'Fix bug' });
      store.claimTask(task.task_id, agentA);
      store.releaseTask(task.task_id, agentA);

      const updated = store.getTask(task.task_id)!;
      expect(updated.status).toBe('pending');
      expect(updated.assignee_agent_id).toBeNull();

      // Another agent can now claim it
      const result = store.claimTask(task.task_id, agentB);
      expect(result.success).toBe(true);
    });

    it('should release all tasks on agent stale rescue', () => {
      const t1 = store.createTask({ projectId: 'proj1', description: 'Task 1' });
      const t2 = store.createTask({ projectId: 'proj1', description: 'Task 2' });
      store.claimTask(t1.task_id, agentA);
      store.claimTask(t2.task_id, agentA);

      const released = store.releaseTasksByAgent(agentA);
      expect(released).toBe(2);

      expect(store.getTask(t1.task_id)!.status).toBe('pending');
      expect(store.getTask(t2.task_id)!.status).toBe('pending');
    });

    it('should list available tasks', () => {
      store.createTask({ projectId: 'proj1', description: 'Available' });
      const claimed = store.createTask({ projectId: 'proj1', description: 'Claimed' });
      store.claimTask(claimed.task_id, agentA);

      const available = store.listTasks('proj1', { available: true });
      expect(available.length).toBe(1);
      expect(available[0].description).toBe('Available');
    });

    it('should reject claim when required_role does not match agent role', () => {
      const engineer = store.registerAgent({ projectId: 'proj1', agentType: 'windsurf', instanceId: 'eng1', role: 'engineer' });
      const reviewer = store.registerAgent({ projectId: 'proj1', agentType: 'cursor', instanceId: 'rev1', role: 'reviewer' });
      const task = store.createTask({ projectId: 'proj1', description: 'Review PR', requiredRole: 'reviewer' });

      // Engineer cannot claim a reviewer-only task
      const engResult = store.claimTask(task.task_id, engineer.agent_id);
      expect(engResult.success).toBe(false);
      expect(engResult.reason).toContain('Role mismatch');
      expect(engResult.reason).toContain('reviewer');

      // Reviewer can claim
      const revResult = store.claimTask(task.task_id, reviewer.agent_id);
      expect(revResult.success).toBe(true);
    });

    it('should allow claim when preferred_role does not match but required_role does', () => {
      const engineer = store.registerAgent({ projectId: 'proj1', agentType: 'windsurf', instanceId: 'eng1', role: 'engineer' });
      const task = store.createTask({ projectId: 'proj1', description: 'Fix bug', requiredRole: 'engineer', preferredRole: 'senior-engineer' });

      // Engineer matches required_role, claim succeeds even though preferred_role doesn't match
      const result = store.claimTask(task.task_id, engineer.agent_id);
      expect(result.success).toBe(true);
      expect(result.hint).toContain('Preferred role');
      expect(result.hint).toContain('senior-engineer');
    });

    it('should allow claim when no required_role is set (role-agnostic)', () => {
      const engineer = store.registerAgent({ projectId: 'proj1', agentType: 'windsurf', instanceId: 'eng1', role: 'engineer' });
      const task = store.createTask({ projectId: 'proj1', description: 'Any role task' });

      const result = store.claimTask(task.task_id, engineer.agent_id);
      expect(result.success).toBe(true);
      expect(result.hint).toBeUndefined();
    });

    it('should sort available tasks by role affinity for a specific agent', () => {
      const senior = store.registerAgent({ projectId: 'proj1', agentType: 'windsurf', instanceId: 'sen1', role: 'senior-engineer' });
      const engineer = store.registerAgent({ projectId: 'proj1', agentType: 'windsurf', instanceId: 'eng1', role: 'engineer' });

      // preferred_role matches senior, required_role also senior → best for senior
      const preferredTask = store.createTask({ projectId: 'proj1', description: 'Senior task', requiredRole: 'senior-engineer', preferredRole: 'senior-engineer' });
      // required_role matches engineer only
      const engTask = store.createTask({ projectId: 'proj1', description: 'Engineer task', requiredRole: 'engineer' });
      // no role constraint
      const anyTask = store.createTask({ projectId: 'proj1', description: 'Any task' });

      // Senior sees: preferred first, then agnostic (engineer-only task excluded)
      const seniorTasks = store.listTasksForAgent('proj1', senior.agent_id);
      expect(seniorTasks.length).toBe(2);
      expect(seniorTasks[0].description).toBe('Senior task');
      expect(seniorTasks[1].description).toBe('Any task');

      // Engineer sees: required first, then agnostic (senior-only task excluded)
      const engTasks = store.listTasksForAgent('proj1', engineer.agent_id);
      expect(engTasks.length).toBe(2);
      expect(engTasks[0].description).toBe('Engineer task');
      expect(engTasks[1].description).toBe('Any task');
    });
  });

  // ═════════════════════════════════════════════════════════════════
  // Locks
  // ═════════════════════════════════════════════════════════════════

  describe('Locks', () => {
    let agentA: string;
    let agentB: string;

    beforeEach(() => {
      agentA = store.registerAgent({ projectId: 'proj1', agentType: 'windsurf', instanceId: 'a' }).agent_id;
      agentB = store.registerAgent({ projectId: 'proj1', agentType: 'cursor', instanceId: 'b' }).agent_id;
    });

    it('should acquire and release a lock', () => {
      const result = store.acquireLock('proj1', 'src/main.ts', agentA);
      expect(result.success).toBe(true);

      const released = store.releaseLock('proj1', 'src/main.ts', agentA);
      expect(released).toBe(true);
    });

    it('should reject lock by different agent', () => {
      store.acquireLock('proj1', 'src/main.ts', agentA);
      const result = store.acquireLock('proj1', 'src/main.ts', agentB);
      expect(result.success).toBe(false);
      expect(result.lockedBy).toBe(agentA);
    });

    it('should allow same agent to re-lock (TTL refresh)', () => {
      store.acquireLock('proj1', 'src/main.ts', agentA);
      const result = store.acquireLock('proj1', 'src/main.ts', agentA);
      expect(result.success).toBe(true);
    });

    it('should auto-expire locks', () => {
      store.acquireLock('proj1', 'src/main.ts', agentA, 1); // 1ms TTL

      // Wait for expiry
      const start = Date.now();
      while (Date.now() - start < 5) { /* spin */ }

      // After expiry, another agent can lock
      const result = store.acquireLock('proj1', 'src/main.ts', agentB);
      expect(result.success).toBe(true);
    });

    it('should release all locks by agent', () => {
      store.acquireLock('proj1', 'src/a.ts', agentA);
      store.acquireLock('proj1', 'src/b.ts', agentA);

      const released = store.releaseAllLocks(agentA);
      expect(released).toBe(2);
      expect(store.listLocks('proj1').length).toBe(0);
    });

    it('should not release locks owned by other agents', () => {
      store.acquireLock('proj1', 'src/main.ts', agentA);
      const released = store.releaseLock('proj1', 'src/main.ts', agentB);
      expect(released).toBe(false);
    });
  });

  // ═════════════════════════════════════════════════════════════════
  // Cross-Process Safety (simulated with two DB handles)
  // ═════════════════════════════════════════════════════════════════

  describe('Cross-Process Safety', () => {
    it('should handle concurrent task claims — only one succeeds', async () => {
      // Create task via store 1
      const task = store.createTask({ projectId: 'proj1', description: 'Race task' });
      const agentA = store.registerAgent({ projectId: 'proj1', agentType: 'windsurf', instanceId: 'a' }).agent_id;
      const agentB = store.registerAgent({ projectId: 'proj1', agentType: 'cursor', instanceId: 'b' }).agent_id;

      // Create a second store pointing to the same DB
      const store2 = new TeamStore();
      await store2.init(tmpDir);

      // Both try to claim simultaneously
      const resultA = store.claimTask(task.task_id, agentA);
      const resultB = store2.claimTask(task.task_id, agentB);

      // Exactly one should succeed
      const successes = [resultA, resultB].filter(r => r.success);
      expect(successes.length).toBe(1);

      // The task should be assigned to exactly one agent
      const final = store.getTask(task.task_id)!;
      expect(final.status).toBe('in_progress');
      expect([agentA, agentB]).toContain(final.assignee_agent_id);
    });

    it('should see messages written by another process', async () => {
      const agentA = store.registerAgent({ projectId: 'proj1', agentType: 'windsurf', instanceId: 'a' }).agent_id;
      const agentB = store.registerAgent({ projectId: 'proj1', agentType: 'cursor', instanceId: 'b' }).agent_id;

      // Send message via store 1
      store.sendMessage({
        projectId: 'proj1',
        senderAgentId: agentA,
        recipientAgentId: agentB,
        type: 'direct',
        content: 'Cross-process message',
      });

      // Read via store 2
      const store2 = new TeamStore();
      await store2.init(tmpDir);
      const inbox = store2.getInbox('proj1', agentB);
      expect(inbox.length).toBe(1);
      expect(inbox[0].content).toBe('Cross-process message');
    });
  });

  // ═════════════════════════════════════════════════════════════════
  // Migration from team-state.json
  // ═════════════════════════════════════════════════════════════════

  describe('Migration', () => {
    it('should migrate team-state.json to SQLite', async () => {
      const migDir = makeTmpDir();
      try {
        // Write a team-state.json
        const jsonState = {
          version: 1,
          updatedAt: new Date().toISOString(),
          registry: {
            agents: {
              'agent-1': {
                id: 'agent-1',
                name: 'Windsurf Agent',
                role: 'developer',
                capabilities: ['code', 'test'],
                status: 'active',
                joinedAt: '2025-01-01T00:00:00.000Z',
                lastSeenAt: '2025-01-01T01:00:00.000Z',
                leftAt: null,
              },
            },
            nameIndex: { 'Windsurf Agent': 'agent-1' },
          },
          messages: {
            inboxes: {
              'agent-1': [
                {
                  id: 'msg-1',
                  from: 'agent-2',
                  to: 'agent-1',
                  type: 'direct',
                  content: 'Hello',
                  timestamp: '2025-01-01T00:30:00.000Z',
                  read: false,
                },
              ],
            },
          },
          tasks: {
            tasks: {
              'task-1': {
                id: 'task-1',
                description: 'Fix the bug',
                status: 'pending',
                deps: [],
                assignee: null,
                result: null,
                metadata: {},
                createdAt: '2025-01-01T00:00:00.000Z',
                updatedAt: '2025-01-01T00:00:00.000Z',
              },
            },
          },
          locks: {
            locks: {
              'src/main.ts': {
                file: 'src/main.ts',
                lockedBy: 'agent-1',
                lockedAt: '2025-01-01T00:00:00.000Z',
                expiresAt: '2099-01-01T00:00:00.000Z',
              },
            },
          },
        };

        fs.writeFileSync(path.join(migDir, 'team-state.json'), JSON.stringify(jsonState, null, 2));

        // Init store — should trigger migration
        const migStore = new TeamStore();
        await migStore.init(migDir);

        // Verify migration
        const agents = migStore.listAgents('migrated');
        expect(agents.length).toBe(1);
        expect(agents[0].name).toBe('Windsurf Agent');

        const tasks = migStore.listTasks('migrated');
        expect(tasks.length).toBe(1);
        expect(tasks[0].description).toBe('Fix the bug');

        const locks = migStore.listLocks('migrated');
        expect(locks.length).toBe(1);

        // JSON file should be renamed
        expect(fs.existsSync(path.join(migDir, 'team-state.json.migrated'))).toBe(true);
        expect(fs.existsSync(path.join(migDir, 'team-state.json'))).toBe(false);
      } finally {
        cleanup(migDir);
      }
    });

    it('should skip migration if team tables already have data', async () => {
      // Store already has data from beforeEach
      store.registerAgent({ projectId: 'proj1', agentType: 'windsurf', instanceId: 'i1' });

      // Write a JSON file that would trigger migration
      fs.writeFileSync(path.join(tmpDir, 'team-state.json'), JSON.stringify({ version: 1, registry: { agents: {} }, messages: { inboxes: {} }, tasks: { tasks: {} }, locks: { locks: {} } }));

      // Re-init — should NOT migrate because table has data
      const store2 = new TeamStore();
      await store2.init(tmpDir);

      // JSON file should still exist (not renamed)
      expect(fs.existsSync(path.join(tmpDir, 'team-state.json'))).toBe(true);
    });
  });

  // ═════════════════════════════════════════════════════════════════
  // Watermark
  // ═════════════════════════════════════════════════════════════════

  describe('Watermark', () => {
    it('should update and read agent watermark', () => {
      const agent = store.registerAgent({ projectId: 'proj1', agentType: 'windsurf', instanceId: 'i1' });
      expect(agent.last_seen_obs_generation).toBe(0);

      store.updateWatermark(agent.agent_id, 42);
      const updated = store.getAgent(agent.agent_id)!;
      expect(updated.last_seen_obs_generation).toBe(42);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // Management Operations (delete, gc, force-leave, update)
  // ═══════════════════════════════════════════════════════════════════

  describe('Management Operations', () => {
    const projectId = 'mgmt-proj';

    function setupTeam() {
      const a1 = store.registerAgent({ projectId, agentType: 'claude-code', instanceId: 'inst-1', name: 'Agent1', role: 'engineer', capabilities: ['code'] });
      const a2 = store.registerAgent({ projectId, agentType: 'cursor', instanceId: 'inst-2', name: 'Agent2', role: 'reviewer' });
      const a3 = store.registerAgent({ projectId, agentType: 'codex', instanceId: 'inst-3', name: 'Agent3' });
      return { a1, a2, a3 };
    }

    // ── deleteAgent ──────────────────────────────────────────────────

    it('should permanently delete an agent', () => {
      const { a1 } = setupTeam();
      expect(store.deleteAgent(a1.agent_id, projectId)).toBe(true);
      expect(store.getAgent(a1.agent_id)).toBeUndefined();
    });

    it('should refuse to delete agent from wrong project', () => {
      const { a1 } = setupTeam();
      expect(store.deleteAgent(a1.agent_id, 'wrong-project')).toBe(false);
      expect(store.getAgent(a1.agent_id)).toBeDefined();
    });

    it('should cascade delete messages when agent is deleted', () => {
      const { a1, a2 } = setupTeam();
      store.sendMessage({ projectId, senderAgentId: a1.agent_id, recipientAgentId: a2.agent_id, type: 'info', content: 'hello' });
      store.sendMessage({ projectId, senderAgentId: a2.agent_id, recipientAgentId: a1.agent_id, type: 'info', content: 'reply' });

      store.deleteAgent(a1.agent_id, projectId);

      // Sender messages deleted
      const msgs = store.listMessages(projectId);
      expect(msgs.every(m => m.sender_agent_id !== a1.agent_id)).toBe(true);
      // Recipient inbox messages deleted
      expect(msgs.every(m => m.recipient_agent_id !== a1.agent_id)).toBe(true);
    });

    it('should release locks when agent is deleted', () => {
      const { a1 } = setupTeam();
      store.acquireLock(projectId, '/src/foo.ts', a1.agent_id);
      store.deleteAgent(a1.agent_id, projectId);
      expect(store.getLockStatus(projectId, '/src/foo.ts')).toBeNull();
    });

    it('should release tasks when agent is deleted', () => {
      const { a1 } = setupTeam();
      const task = store.createTask({ projectId, description: 'do work' });
      store.claimTask(task.task_id, a1.agent_id);

      store.deleteAgent(a1.agent_id, projectId);

      const t = store.getTask(task.task_id);
      expect(t!.status).toBe('pending');
      expect(t!.assignee_agent_id).toBeNull();
    });

    // ── deleteAgentsByProject ────────────────────────────────────────

    it('should only delete inactive agents in bulk', () => {
      const { a1, a2, a3 } = setupTeam();
      store.leaveAgent(a2.agent_id); // a2 becomes inactive
      const deleted = store.deleteAgentsByProject(projectId);
      expect(deleted).toBe(1);
      expect(store.getAgent(a1.agent_id)).toBeDefined(); // active, kept
      expect(store.getAgent(a2.agent_id)).toBeUndefined(); // inactive, deleted
      expect(store.getAgent(a3.agent_id)).toBeDefined(); // active, kept
    });

    // ── deleteTeam ───────────────────────────────────────────────────

    it('should wipe all team data for a project', () => {
      const { a1, a2 } = setupTeam();
      store.sendMessage({ projectId, senderAgentId: a1.agent_id, recipientAgentId: a2.agent_id, type: 'info', content: 'hello' });
      store.createTask({ projectId, description: 'task1' });
      store.acquireLock(projectId, '/src/bar.ts', a1.agent_id);

      const result = store.deleteTeam(projectId);
      expect(result.agents).toBe(3);
      expect(result.messages).toBe(1);
      expect(result.tasks).toBe(1);
      expect(result.locks).toBe(1);

      expect(store.listAgents(projectId)).toHaveLength(0);
      expect(store.listMessages(projectId)).toHaveLength(0);
      expect(store.listTasks(projectId)).toHaveLength(0);
    });

    // ── forceLeaveAgent ──────────────────────────────────────────────

    it('should force leave an active agent, releasing tasks and locks', () => {
      const { a1 } = setupTeam();
      const task = store.createTask({ projectId, description: 'do work' });
      store.claimTask(task.task_id, a1.agent_id);
      store.acquireLock(projectId, '/src/baz.ts', a1.agent_id);

      const result = store.forceLeaveAgent(a1.agent_id);
      expect(result.success).toBe(true);
      expect(result.releasedTasks).toBe(1);
      expect(result.releasedLocks).toBe(1);

      const agent = store.getAgent(a1.agent_id);
      expect(agent!.status).toBe('inactive');

      const t = store.getTask(task.task_id);
      expect(t!.assignee_agent_id).toBeNull();
      expect(store.getLockStatus(projectId, '/src/baz.ts')).toBeNull();
    });

    it('should return false for force-leaving non-existent agent', () => {
      const result = store.forceLeaveAgent('non-existent');
      expect(result.success).toBe(false);
    });

    // ── updateAgentCapabilities ──────────────────────────────────────

    it('should update agent capabilities', () => {
      const { a1 } = setupTeam();
      expect(store.updateAgentCapabilities(a1.agent_id, ['code', 'review'])).toBe(true);
      const agent = store.getAgent(a1.agent_id);
      expect(JSON.parse(agent!.capabilities!)).toEqual(['code', 'review']);
    });

    // ── updateAgentRole ──────────────────────────────────────────────

    it('should update agent role', () => {
      const { a1 } = setupTeam();
      expect(store.updateAgentRole(a1.agent_id, 'planner')).toBe(true);
      const agent = store.getAgent(a1.agent_id);
      expect(agent!.role).toBe('planner');
    });

    // ── listMessages ─────────────────────────────────────────────────

    it('should list all messages for a project', () => {
      const { a1, a2 } = setupTeam();
      store.sendMessage({ projectId, senderAgentId: a1.agent_id, recipientAgentId: a2.agent_id, type: 'info', content: 'hello' });
      store.sendMessage({ projectId, senderAgentId: a2.agent_id, recipientAgentId: a1.agent_id, type: 'info', content: 'reply' });
      const msgs = store.listMessages(projectId);
      expect(msgs).toHaveLength(2);
    });

    it('should filter messages by sender', () => {
      const { a1, a2 } = setupTeam();
      store.sendMessage({ projectId, senderAgentId: a1.agent_id, recipientAgentId: a2.agent_id, type: 'info', content: 'hello' });
      store.sendMessage({ projectId, senderAgentId: a2.agent_id, recipientAgentId: a1.agent_id, type: 'info', content: 'reply' });
      const msgs = store.listMessages(projectId, { senderId: a1.agent_id });
      expect(msgs).toHaveLength(1);
      expect(msgs[0].sender_agent_id).toBe(a1.agent_id);
    });

    it('should filter messages by type', () => {
      const { a1, a2 } = setupTeam();
      store.sendMessage({ projectId, senderAgentId: a1.agent_id, recipientAgentId: a2.agent_id, type: 'info', content: 'hello' });
      store.sendMessage({ projectId, senderAgentId: a2.agent_id, recipientAgentId: a1.agent_id, type: 'request', content: 'do work' });
      const msgs = store.listMessages(projectId, { type: 'request' });
      expect(msgs).toHaveLength(1);
      expect(msgs[0].type).toBe('request');
    });

    it('should filter messages by date range', () => {
      const { a1, a2 } = setupTeam();
      store.sendMessage({ projectId, senderAgentId: a1.agent_id, recipientAgentId: a2.agent_id, type: 'info', content: 'old' });
      const msgs = store.listMessages(projectId, { since: Date.now() + 100000 });
      expect(msgs).toHaveLength(0);
    });

    it('should limit results', () => {
      const { a1, a2 } = setupTeam();
      for (let i = 0; i < 10; i++) {
        store.sendMessage({ projectId, senderAgentId: a1.agent_id, recipientAgentId: a2.agent_id, type: 'info', content: `msg-${i}` });
      }
      const msgs = store.listMessages(projectId, { limit: 3 });
      expect(msgs).toHaveLength(3);
    });

    // ── gcStaleAgents ────────────────────────────────────────────────

    it('should permanently delete inactive agents older than threshold', () => {
      const { a1, a2 } = setupTeam();
      store.leaveAgent(a2.agent_id);

      const deleted = store.gcStaleAgents(projectId, 0); // threshold=0 means delete all inactive
      expect(deleted).toBe(1);
      expect(store.getAgent(a2.agent_id)).toBeUndefined();
      expect(store.getAgent(a1.agent_id)).toBeDefined(); // active, kept
    });

    it('should not delete recently inactive agents', () => {
      const { a1, a2 } = setupTeam();
      store.leaveAgent(a2.agent_id);

      // Very large threshold = only delete agents inactive for a very long time
      const deleted = store.gcStaleAgents(projectId, 999999999999);
      expect(deleted).toBe(0);
      expect(store.getAgent(a2.agent_id)).toBeDefined();
    });
  });
});
