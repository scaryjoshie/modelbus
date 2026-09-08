# Native delivery tracking and crash behavior

Read-only investigation, 2026-09-07. These are observations and test questions, not
a settled delivery protocol. No messages were sent and no live sessions were stopped
for this investigation. Crash/resume behavior has not yet been experimentally tested.

**Scope clarification from Joshua:** crash detection is not needed for v0. Crash
experiments and automatic recovery/resending are deferred. Future resend decisions
must account for each provider's persistence and replay behavior, rather than use
one unconditional bus-wide retry rule. This document is research for that later work,
not an additional v0 acceptance requirement. Queue/turn observations may still be
useful for ordinary delivery tracking.

## What we want to know

Ordinary DMs should arrive automatically where the host supports it. A model-facing
`sync` is not needed merely to receive a body already queued into the host. Its
remaining role depends on pull-only providers and any recovery/catch-up needs.

Keep these observations separate:

1. Modelbus stored the message.
2. The host accepted it into a native queue.
3. The specific message appeared in the host conversation.
4. A turn containing that message started.
5. The agent replied.

Queue disappearance or a generic busy/idle transition does not prove step 4. A
queue item can be deleted, and an agent can be busy with unrelated work. A turn
starting establishes host processing, not that the model understood or completed
the requested work. Prefer native IDs for correlation; exact-text matching is weaker.

## Codex: local CLI 0.153.4

Observed locally:

- `codex queue --thread <id> --message <text>` exists. The earlier round-trip
  experiment established automatic delivery into an existing TUI.
- `~/.codex/queue_1.sqlite` has `queued_items`, with `id`, `thread_id`,
  `payload_json`, queue order, and timestamps. It also has per-thread revisions
  updated by insert/update/delete triggers. Pending data is stored on disk.
- This schema has no consumed/processed status column or separate consumption log.
  Removing an item cannot, by itself, distinguish consumption from deletion.
- The CLI-generated protocol schema exposes `thread/queue/add`, `list`, `update`,
  `delete`, `reorder`, `start`, and `thread/queue/changed`.
- `thread/queue/add` accepts `clientUserMessageId`; its response supplies a
  `queuedSubmission` with a native `id` and that client ID. Listing returns those
  same fields. A changed notification identifies the thread, requiring a list refresh.
- User-message items in `item/started` and `thread/read` have an optional `clientId`;
  item notifications also identify their thread and turn. This is a promising
  correlation path, **not yet verified** to preserve the queue's client ID when an
  independently running TUI consumes the message.
- `thread/queue/start` accepts an optional queued-submission ID and returns a turn.
  That is an active operation, not an observation API; it was not called.

Reproduce the schema inspection without starting an agent turn:

```sh
codex app-server generate-json-schema --experimental --out /tmp/modelbus-protocol
```

Relevant generated files include `ThreadQueueAddParams.json`,
`ThreadQueueAddResponse.json`, `ThreadQueueListResponse.json`,
`ThreadQueueChangedNotification.json`, `ItemStartedNotification.json`, and
`ThreadReadResponse.json` under `v2/`. These fields are version-specific; schema
availability does not prove a separate observer receives events from an existing TUI.
The official [app-server documentation](https://learn.chatgpt.com/docs/app-server)
describes schema generation and turn/item events.

**Crash inference:** pending messages are not just an in-memory modelbus queue.
An ordinary modelbus exit does not itself erase Codex's separate database. Disk
storage is evidence for durability, but automatic reload, cleanup on exit, and the
ordering of queue removal versus transcript persistence still require a host test.
The presence of a client ID also does not establish idempotent retries by itself.

## Claude Code

The [cross-session messaging documentation](https://code.claude.com/docs/en/cross-session-messaging)
distinguishes delivered, held, and refused messages. Its non-interactive-session
section says held messages expire when the session ends. That specific behavior
must not be generalized to every accepted message or abrupt-crash condition.

Claude normally saves conversation messages to local JSONL transcripts, according
to [how Claude Code works](https://code.claude.com/docs/en/how-claude-code-works).
Seeing a correlated message in the transcript would provide stronger evidence than
a successful socket write. Transcript presence still differs from turn start or
completion, and persistence can be disabled in some configurations.

**Unverified:** a receipt suitable for the proposed raw-socket poster; the lifetime
of accepted-but-unprocessed messages; whether a delivered bus message can be
correlated with a turn; and the outcome of a crash between enqueue and transcript
write. Do not claim that a successful socket post is durable delivery.

## Aside

Read-only schema inspection found persisted `sessions.queued_messages` and
`sessions.steering_messages`, plus `session_runs` fields including `started_at`,
`finished_at`, `aborted_at`, and `resume_attempts`. These are undocumented local
details. They suggest places to inspect queue and run transitions; they do not
establish correlation or crash recovery.

The proposed POC path remains a heartbeat routine calling an MCP pull tool. Session
identity and the routine's behavior remain untested. A successful routine run alone
does not establish which bus messages were processed.

## Future crash experiment (deferred beyond v0)

Use disposable sessions with harmless messages and record host version, native
session ID, bus message ID, queue ID if available, and observations before/after.

| Test boundary | Restart separately | Observe |
|---|---|---|
| Stored by modelbus, not yet handed to host | Modelbus | Bus record survives; pending delivery remains identifiable |
| Accepted into host queue, not yet consumed | Modelbus; recipient process; host daemon where distinct | Item retained, removed, or replayed; whether resume consumes it |
| Removed from queue, before a correlated transcript/turn observation | Recipient process; host daemon | Whether the message is recoverable or the handoff loses it |
| Present in transcript / turn started | Modelbus; recipient process | Whether resume preserves context, repeats the input, or requires user continuation |
| Queue item deliberately cancelled | Normal operation | Cancellation is distinguishable from processing where possible |

Separate graceful exit/resume from abrupt termination. Observe natural host recovery
before introducing modelbus retries; otherwise we cannot tell which layer replayed
the message. Do not run crash tests against ongoing user work.

Joshua does not require an exactly-once guarantee for v0. When recovery is added,
avoid catastrophic repeated actions; the reconciliation policy is OPEN until we
know whether each host tends to save or lose pending messages. Recovery behavior
belongs with that provider knowledge; the exact interface is undecided. Retain the
bus record and the evidence; an unknown outcome is not automatically a failed send.
