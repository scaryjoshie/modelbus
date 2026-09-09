# modelbus architecture (as built, 2026-09-08)

This describes the code that exists, not plans. For open questions see
`design-notes.md`; for the running status and lessons see `handoff.md`.

## 1. What it is

A local message bus so the AI agent sessions on one machine can send each other
direct messages. One daemon per user. Agents are Claude Code sessions, Codex
sessions, Aside browser sessions, and any process that registers itself. The bus
delivers into each host through that host's own mechanism; models never poll.

Premise: stop the user being the relay between their own tools.

## 2. Layout and the layering rule

```
src/
  core/        store.ts (all SQL), schema.ts (Drizzle tables), api.ts (send/pull),
               guards.ts, adapter.ts (host interface), delivery.ts (result type),
               paths.ts
  util/        ps.ts (process table, ancestors), watch.ts (transcript watcher)
  adapters/    claude-code.ts, codex.ts, aside.ts, registered.ts, index.ts
  daemon.ts    composition root: store + api + tracker + adapters + RPC socket
  tracker.ts   reconcile loop, identity binding, delivery dispatch, roster
  client.ts    rpc() over the unix socket      identity.ts  "who am I" for shim/CLI
  ensure.ts    start the daemon on demand      render.ts    one-line message text
  cli.ts       command table (bus verbs + adapter-contributed verbs)
  mcp.ts       the stdio MCP shim hosts spawn per session
scripts/check-layers.ts   fails the build on layering violations
drizzle/                  generated migrations, applied when the store opens
```

Rule: **core is what would exist with zero known hosts.** `core/` and `util/` import
nothing else; `adapters/` import only core and util; everything else may import
anything. A host's name may appear only inside its adapter. `bun run check` runs
the type check, lint, layering check, and tests.

## 3. Data model (`core/schema.ts`)

| Table | Row per | Purpose |
|---|---|---|
| `agents` | agent | ours: `id` (permanent, opaque), `name` (display; follows the host's name until `nameSource = user`), `host`, `state` live/gone/unknown, `lastSeen` |
| `handles` | agent | the host's identity for the session, `handle` (JSON, sealed: only its adapter reads it), `key` (opaque equality string, unique per host), `durability` process/session/permanent, `attestation` observed/attested, `evidence` |
| `presence` | agent | last observation: pid, cwd, status, title, relationship, reachable, note |
| `conversations` | pair | `kind = dm`, `key = dm:<sorted ids>` so there is one DM per pair |
| `messages` | message | `seq` (global order), `id` (short random; appears in delivered text), conversation, sender, body |
| `deliveries` | message × recipient | `wakeResult` (DeliveryOutcome), `wakeDetail`, `wakeAttemptedAt`, `receivedAt` (null = unread) |

Inbox state is per delivery row, not a per-agent cursor, so a scoped read or a
send-and-wait consumes one conversation without skipping others.

Schema changes: edit `schema.ts`, run `bun run migrate:generate`, commit the
migration. The store applies pending migrations on open.

## 4. Identity

Three layers, never mixed:

- **Agent id**: ours, permanent, the only identifier that appears in messages,
  logs, or `who`.
- **Handle + key**: produced by the host's adapter. The core stores the handle
  sealed and uses the key only for equality. Same (host, key) = same agent, across
  daemon restarts and host restarts that keep the host's identity (`--resume`,
  `codex resume`).
- **Attestation**: `observed` (the tracker saw the session from outside) or
  `attested` (the session identified itself via hook or shim). Only moves upward.

Callers identify themselves on the RPC with one of:

| kind | fields | resolved by |
|---|---|---|
| `self` | host, key, name, evidence | `tracker.identify`: bind attested; handle rebuilt by the adapter |
| `token` | token | lookup in `handles` (host `registered`); touches the adapter's contact clock |
| `cli` | as | test only; prints a warning |

`identity.ts` decides which to send from inside a process: explicit `--as`, then
`MODELBUS_TOKEN`, then `MODELBUS_HOST/KEY/NAME` (for hosts that run one shim for
many sessions), then each adapter's `identifySelf()` (ancestor pids), then
`MODELBUS_AS`.

## 5. The adapter interface (`core/adapter.ts`)

```
observe()                      -> Observation[]   what is live on this host now
handleFromKey(key)             -> handle          rebuild a sealed handle
identifySelf?()                -> SelfIdentity    am I inside one of your sessions?
deliver?(handle, text, marker, onReceipt) -> DeliveryResult
attach?(handle, info)                           runtime secrets a session hands over
configure?()                   -> ConfigurePlan  what `init` writes
commands?()                    -> CLI verbs this host needs
```

An `Observation` carries the handle, key, preferred name, durability,
relationship (`top-level` | `subagent` | `unknown`), evidence, reachability, and
display facts. Only `top-level` observations become agents.

`DeliveryResult.outcome` is one of `delivered`, `delivered-unattested`, `waiting`
(no push path; recipient must pull), `returned-to-waiter` (given to a blocked
send-and-wait instead of pushed), `unavailable`, `error`; `detail` says why or how.

## 6. The tracker (`tracker.ts`)

Every 3 s, and on demand: for each adapter, `observe()`; for each top-level
observation, `store.bind()` (find by key or create) and refresh presence; agents of
that host not seen this pass become `gone`. A throwing adapter is skipped, never
marking anything gone. `identify()` handles self-identification; `attach()` forwards
runtime info to the adapter; `deliver()` looks up the agent's handle and adapter and
returns the adapter's `DeliveryResult` (or `error` if it threw); `list()` builds the
roster from agents + presence + handles, reachable first.

## 7. A send, end to end (`core/api.ts`)

1. RPC `send { to, body, wait? }` with an identity. The method table validates
   params and resolves the identity to the sender's agent id.
2. Recipient resolved by name (after one reconcile pass if unknown).
3. Guards: body ≤ 64 KB, not identical to something the sender wrote in this DM in
   the last 60 s, sender under 10 sends/minute. Refusals are `ApiError` → HTTP 422.
4. Message + delivery row inserted in one transaction; an in-process event fires so
   long-polls wake.
5. Delivery via the injected `deliver` (the tracker's). Result stored on the row.
   If the recipient is blocked in send-and-wait for a reply from this sender, the
   message is returned through that call instead (`returned-to-waiter`).
6. Receipt is separate: the adapter captured the host transcript's size before
   delivering and polls it for a line containing `#<message id>` in the host's
   "user message" shape; then `receivedAt` is set.
7. With `wait`, the API blocks (up to 600 s) for the next message from the
   recipient in this DM and returns it inline.

`pull { scope?, wait?, limit? }` returns unreceived deliveries (oldest first, cap
50), marks them received, and reports `more` and `moreElsewhere`. It exists for
pull-only recipients and explicit catch-up; hosts with a push path never need it.

Delivered text is one attribution line plus the body:
`[modelbus #<id>] from <name>` — no instructions.

## 8. Hosts

| Host | Identity (sealed) | Observe | Deliver | Receipt | `init` writes |
|---|---|---|---|---|---|
| Claude Code | session id from `~/.claude/sessions/<pid>.json` | registry files with a live pid | post to the session's inbox socket via a short-lived helper, with the token if attached | `~/.claude/projects/.../<session>.jsonl`: `queue-operation remove` or a `user` entry | user settings: allow `mcp__modelbus__*`, SessionStart hook; `claude mcp add -s user` |
| Codex | root thread id (lock files held by the process; classified by state DB `thread_source`, rollout header, or single-lock rule) | `codex` processes on a tty | `codex queue --thread <id>` | rollout `response_item` user message | `codex mcp add`; `[mcp_servers.modelbus.tools.<t>] approval_mode = "approve"` |
| Aside | session id + account from `~/.aside/u/<N>/state.db` | daemon health + state DB, last 7 days | `aside --account u<N> session queue <id>` | `~/.aside/u/<N>/sessions/<date>_<id>/messages.jsonl` user entry | each account's settings: `mcp.servers.modelbus` (env names the account) + cached tool inventory |
| registered | token | contact clock (or pid) | run its `--deliver` command with text on stdin, else waiting | command exit 0 | none |

Claude Code specifics: the token is consulted only if the posting process has
exited, hence the helper. Sessions started before `init` have no token until they
run `attach` or make a tool call through the shim; their deliveries are
`delivered-unattested` and a bypass-mode session holds them behind a dialog.

Codex specifics: a thread with no turns yet cannot be queued to ("no rollout
found"), shown as not reachable. Codex reads config at launch; sessions started
before `init` prompt once per tool. Codex's shell sandbox blocks the daemon socket,
so the MCP shim is the only door from inside Codex.

Aside specifics: reads MCP settings at startup (restart after `init`). One shim per
account, so messages from Aside are attributed to the account (`aside-1`), not the
session. Aside declines browser actions "requested solely by another agent" on its
own policy.

## 9. Protocol and clients

RPC: POST `{ method, params, identity? }` to `~/.modelbus/daemon.sock` path `/rpc`.
Methods: `ping`, `bind`, `attach`, `register`, `send`, `pull`, `who`, `log`. See
`protocol.md`.

Clients: the CLI (`send`, `sync`, `who`, `log`, `register`, `init`, `mcp`, `serve`,
plus adapter verbs `hook`, `attach`, `post`); the MCP shim (`send`, `who`, and
`sync` only with `--with-sync`; one-sentence instructions); any program via the
socket. `MODELBUS_HOME` points clients at another instance. The daemon is started
on demand by any client.

## 10. Guards (`core/guards.ts`)

Dedupe window 60 s, 10 sends per sender per minute, 64 KB body, 600 s max wait,
50 items per pull. No wake budget, no hop counter, no contact policy in v0.
