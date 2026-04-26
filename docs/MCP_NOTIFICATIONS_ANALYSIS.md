# Memorix Team Notifications — Implementation Guide

## Overview

Memorix team notifications use a **dual-channel approach** to deliver team event hints to connected agents:

1. **Channel 1: Response Injection** (primary, guaranteed) — appends unread message hints to tool responses
2. **Channel 2: MCP Logging Notification** (best-effort push) — fires `sendLoggingMessage` for capable clients

### Why dual-channel?

MCP has no server-initiated mechanism that can wake an idle agent. `sendLoggingMessage` is the only push mechanism in the current spec, but:
- The MCP Python SDK does not reliably route `LoggingMessageNotification` to client handlers (transport-layer issue)
- Some clients may ignore logging notifications entirely
- `sendLoggingMessage` is broadcast (not per-agent targeted)

Response injection guarantees delivery when an agent is actively making tool calls, regardless of client capabilities.

---

## Channel 1: Response Injection

**How it works:** The `registerTool` wrapper intercepts every tool call. When the calling agent is part of a team (`currentAgentId` set) and has unread messages, a `[NOTIFICATION]` hint is appended to the tool response text.

**Payload format:**
```
[NOTIFICATION] 3 unread team message(s). Use team_message inbox or memorix_poll.
```

**Conditions:**
- Only active when `teamFeaturesEnabled` (tool profile is `team` or `full`)
- Only when agent has joined the team (`currentAgentId` is set)
- Skipped for `memorix_poll` and `team_message` (already show inbox)
- Best-effort: errors are caught and never break tool responses

**Client integration:** Zero changes required. Any MCP client that calls Memorix tools will see the notification hint in the response text.

**Limitations:**
- Only works during active tool calls (cannot wake idle agents)
- Agent must be calling Memorix tools to receive hints

---

## Channel 2: MCP Logging Notification

**How it works:** When a team message is sent or broadcast, Memorix calls `server.server.sendLoggingMessage()` with a structured payload. Clients that handle `LoggingMessageNotification` can process these events.

**Payload format:**
```json
{
  "level": "info",
  "logger": "memorix.team",
  "data": {
    "kind": "memorix_team_message",
    "id": "msg-uuid",
    "from": "agent-name",
    "type": "request",
    "description": "First line of message content (max 127 chars)…"
  }
}
```

**Payload fields:**
- `kind` — always `"memorix_team_message"` for team events
- `id` — message UUID
- `from` — sender agent name (falls back to agent ID)
- `type` — message type (`request`, `response`, `info`, `handoff`, etc.)
- `description` — first non-empty line of content, clipped to 127 chars

**Note:** This is broadcast to all connected MCP clients. No per-agent targeting. Client-side filtering is the client's responsibility.

**Client integration:**
1. Handle `notifications/message` (MCP `LoggingMessageNotification`)
2. Check `data.kind === 'memorix_team_message'`
3. Route to the appropriate agent/event system
4. Note: MCP Python SDK's SSE transport may not deliver these — verify with your client

---

## Implementation Details

### Files

| File | Role |
|------|------|
| `src/team/notification-overlay.ts` | `describeTeamMessage()` and `buildTeamEventPayload()` utilities |
| `src/server.ts` | Response injection in `registerTool` wrapper; direct `sendLoggingMessage` in `team_message` handler |

### Tool Profile Gating

Team notification features are only active in `team` or `full` tool profiles:
```typescript
const teamFeaturesEnabled = isToolInProfile('team_manage', toolProfile);
```

In `lite` profile, no team tools are registered and no notification hints are injected.

### Agent Identity

`currentAgentId` is set when an agent joins via:
- `memorix_session_start` with `joinTeam: true`
- `team_manage join`

Response injection only fires when `currentAgentId` is set and the agent has unread messages.

---

## Future: MCP Standard Evolution

Current MCP extensions under development may provide better notification mechanisms:

| Mechanism | Status | Use Case |
|-----------|--------|----------|
| `notifications/resources/updated` | Spec exists, not widely implemented | Watch for observation/message changes |
| SEP-1686 Tasks | Draft | Standard task lifecycle notifications |
| SEP-1577 Sampling | Spec exists | Server→LLM requests (wrong tool for notifications) |
| SEP-992 Webhooks | Draft | External event integration |

When these mature, they can supplement or replace the dual-channel approach without breaking existing clients.
