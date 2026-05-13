# Cairn Session Timeline Protocol

> Version: v1 (2026-05-13, A1.1 data-layer)
> Audience: coding agents (Claude Code / Cursor / Aider) running inside a Cairn-enabled project.

Session timeline events are short JSON records that agents write to the Cairn scratchpad
so the desktop-shell panel can reconstruct "what this session did" in chronological order.
They live in scratchpad, use the existing `cairn.scratchpad.write` tool, and require no
new MCP tools.

---

## 1. Key namespace

```
session_timeline/<agent_id>/<ulid>
```

- `<agent_id>` — your Cairn session id (`CAIRN_SESSION_AGENT_ID` env var, or read from
  `cairn.process.status`).  Format: `cairn-session-<12hex>` (26 chars).
- `<ulid>` — 26-character Crockford base-32 ULID, monotonically sortable.  Generate one
  before each write; keep the value so you can reference it later as `parent_event_id`.

Example key: `session_timeline/cairn-session-a1b2c3d4e5f6/01HXYZ1234ABCDEF56789ABC01`

---

## 2. Event JSON shape

```json
{
  "ts": 1715621234567,
  "kind": "start" | "progress" | "done" | "blocked" | "unblocked"
        | "spawn" | "subagent_return" | "checkpoint" | "mentor",
  "label": "≤120-char human-readable description",
  "agent_id": "cairn-session-<12hex>",
  "task_id": "<task_id if scoped to a task — omit if none>",
  "parent_event_id": "<ULID of a prior event that this event closes or belongs to>",
  "source": "agent" | "mentor" | "kernel"
}
```

All fields except `task_id` and `parent_event_id` are required.  Omit optional fields
rather than setting them to `null`.

### Field constraints

| Field | Type | Notes |
|---|---|---|
| `ts` | integer | `Date.now()` — milliseconds since epoch |
| `kind` | string enum | See §3 |
| `label` | string | ≤ 120 characters; terse verb phrase |
| `agent_id` | string | Must match the key namespace segment |
| `task_id` | string (optional) | Cairn task UUID, if the step belongs to a task |
| `parent_event_id` | string (optional) | ULID of the `start` or `spawn` event this event closes |
| `source` | `"agent"` \| `"mentor"` \| `"kernel"` | Who wrote the event |

---

## 3. Kind semantics and trigger timing

| Kind | Written by | When to write | Typical `parent_event_id` |
|---|---|---|---|
| `start` | agent | Just before beginning a meaningful chunk of work (>30 s, involves file changes, tests, or decisions) | none — this opens a pair |
| `progress` | agent | Optional mid-work milestone ("47/51 tests passing") | the `start` ULID of the current chunk |
| `done` | agent | Immediately after the chunk completes successfully | the `start` ULID of the same chunk |
| `blocked` | agent | When calling `cairn.task.block` — write this first | the `start` ULID of the blocked chunk |
| `unblocked` | agent | When a blocker resolves and work resumes | the `blocked` ULID |
| `spawn` | agent | Just before spawning a subagent — record the ULID and pass it to the subagent prompt | none — this opens a subagent branch |
| `subagent_return` | agent | When the parent agent receives the subagent's result | the `spawn` ULID |
| `checkpoint` | agent | Immediately after calling `cairn.checkpoint.create` — marks a safe rewind point | the most recent `done` ULID (optional) |
| `mentor` | mentor/kernel | Written by Mentor policy engine on auto-resolve, nudge, or escalation — `source: "mentor"` | the `blocked` ULID if auto-resolving |

---

## 4. What to write vs. what to skip

**Write a timeline event for:**
- Starting a meaningful work segment (edit files, run tests, make a decision)
- Completing that work segment
- Hitting a blocker (`cairn.task.block`)
- Spawning a subagent
- Receiving a subagent result
- Creating a checkpoint

**Do NOT write for:**
- Pure read operations: `Read`, `Grep`, `Glob`, `cairn.scratchpad.read`, `cairn.task.get`
- Quick config/status queries that take < a few seconds
- `cairn.process.heartbeat` or `cairn.process.status` calls
- Internal retries within a single attempt (no new meaningful boundary)

The goal is signal, not noise.  A session with 100 tool calls typically produces 5–15
timeline events.

---

## 4.5 Gotcha — pass plain object, NOT pre-stringified JSON

`cairn.scratchpad.write` accepts `content: any` and serializes it once.
If you pass a pre-stringified JSON string, the result is double-encoded
(stored as `"\"{\\\"ts\\\":...}\""`), and the renderer parses it once
back to a string, not an object. **Always pass a plain object** as
`content`. Real-agent dogfood 2026-05-14 caught this.

The `desktop-shell::querySessionTimeline` renderer is defensively
double-parse aware (handles both cases) — but writing correctly avoids
the cost of the second parse and surfaces a smaller value_json row.

## 5. Agent-side pseudocode

```javascript
// 1. Generate a ULID (26-char Crockford base-32, same algorithm as mentor-policy.cjs::newUlid)
const startUlid = newUlid();  // e.g. "01HXYZ1234ABCDEF56789ABC01"
const agentId = process.env.CAIRN_SESSION_AGENT_ID;

// 2. Write a "start" event before the work begins
await cairn.scratchpad.write({
  key: `session_timeline/${agentId}/${startUlid}`,
  content: {
    ts: Date.now(),
    kind: "start",
    label: "refactor auth tests — extract shared setup",
    agent_id: agentId,
    task_id: currentTaskId,   // omit if no task scope
    source: "agent"
  }
});

// ... do the work ...

// 3. Write a "done" event afterwards, referencing the start ULID
const doneUlid = newUlid();
await cairn.scratchpad.write({
  key: `session_timeline/${agentId}/${doneUlid}`,
  content: {
    ts: Date.now(),
    kind: "done",
    label: "auth tests refactored — 51/51 passing",
    agent_id: agentId,
    task_id: currentTaskId,
    parent_event_id: startUlid,
    source: "agent"
  }
});
```

---

## 6. Subagent tree rules

The `parent_event_id` field links events across agent boundaries to form a tree.

### Rule 1 — Parent writes spawn first

Before the parent agent launches a subagent, it writes a `kind: "spawn"` event and
notes the resulting ULID:

```javascript
const spawnUlid = newUlid();
await cairn.scratchpad.write({
  key: `session_timeline/${parentAgentId}/${spawnUlid}`,
  content: {
    ts: Date.now(),
    kind: "spawn",
    label: "spawn subagent: investigate test failures in auth module",
    agent_id: parentAgentId,
    source: "agent"
  }
});
```

### Rule 2 — Parent passes spawn ULID to subagent via prompt

The parent must inject `spawnUlid` into the subagent's prompt.  Example:

```
You are a subagent inside a Cairn-enabled project.
Your Cairn session agent id is: <subagentAgentId>
Your parent's spawn event ULID is: <spawnUlid>
Write your first timeline event with parent_event_id: "<spawnUlid>"
```

### Rule 3 — Subagent's first event references the spawn ULID

The subagent writes its first `kind: "start"` event with `parent_event_id = <spawnUlid>`:

```javascript
const subStartUlid = newUlid();
await cairn.scratchpad.write({
  key: `session_timeline/${subAgentId}/${subStartUlid}`,
  content: {
    ts: Date.now(),
    kind: "start",
    label: "investigate auth test failures",
    agent_id: subAgentId,
    parent_event_id: spawnUlid,   // <-- links to parent's spawn event
    source: "agent"
  }
});
```

### Rule 4 — Parent writes subagent_return when result arrives

After the subagent's result is available (e.g. from `subagent/{agent_id}/result` key):

```javascript
const returnUlid = newUlid();
await cairn.scratchpad.write({
  key: `session_timeline/${parentAgentId}/${returnUlid}`,
  content: {
    ts: Date.now(),
    kind: "subagent_return",
    label: "subagent returned: 3 root causes found in auth setup",
    agent_id: parentAgentId,
    parent_event_id: spawnUlid,   // closes the spawn branch
    source: "agent"
  }
});
```

### Tree shape

```
parent: spawn (spawnUlid)
  └── subagent: start (parent_event_id=spawnUlid)
        └── subagent: done (parent_event_id=subStartUlid)
parent: subagent_return (parent_event_id=spawnUlid)
```

The panel reads all `session_timeline/<agent_id>/*` keys (sorted by ULID = chronological),
joins across agent_ids via `parent_event_id` references, and renders the tree.

---

## 7. ULID generation

The same algorithm used in `packages/desktop-shell/mentor-policy.cjs::newUlid`:
- Crockford base-32, 26 characters
- First 10 chars encode millisecond timestamp (monotonic in same ms)
- Last 16 chars are random

For agents that don't have a ULID library, a minimal implementation:

```javascript
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function newUlid() {
  let t = Date.now();
  let ts = '';
  for (let i = 9; i >= 0; i--) {
    ts = CROCKFORD[t % 32] + ts;
    t = Math.floor(t / 32);
  }
  let rand = '';
  for (let i = 0; i < 16; i++) rand += CROCKFORD[Math.floor(Math.random() * 32)];
  return ts + rand;
}
```

---

## 8. Reserved keys

Do not write timeline events to any key outside the `session_timeline/<agent_id>/` prefix.
Other reserved namespaces (do not write):
- `project_profile/*` — desktop-shell CAIRN.md cache
- `mentor/*` — Mentor outbound
- `escalation/*` — Module 5 (Needs you)
- `agent_inbox/*` — inbound steer messages to agents
- `session_name/*` — session display name (managed by `cairn.session.name`)
- `subagent/*` — subagent result blobs (managed by subagent protocol)
