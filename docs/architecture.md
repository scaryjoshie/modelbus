# modelbus architecture (as built, 2026-09-09)

This describes the code that exists, not plans. For current design direction and
open questions see `runtime-and-providers.md`; for status and lessons see `handoff.md`.

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
               limits.ts (tunable policy, with defaults), delivery.ts (result type), paths.ts
  runtime/     provider.ts (Provider, Discovery, Connector, identity/setup contracts),
               discovery.ts (observe without registration),
               provider-manager.ts (reconciliation, presence, routing, roster),
               secrets.ts (what providers ask the daemon to remember; owner-only files)
  util/        ps.ts (process table, ancestors), watch.ts (transcript watcher, file events),
               attribution.ts (default plain-text form of a message, and its read mark)
  providers/   one folder per host: index.ts (the class), the host's layout,
               configure.ts (what init writes); index.ts lists them
  daemon.ts    composition root: store + api + provider manager + providers + RPC method table
  client.ts    typed rpc() and bound createClient() over the unix socket
  identity.ts  "who am I" for shim/CLI
  ensure.ts    start the daemon on demand         render.ts    one-line message text
  cli.ts       command table
  mcp.ts       the stdio MCP shim hosts spawn per session
scripts/check-layers.ts   fails the build on layering violations
drizzle/                  generated migrations, applied when the store opens
```

Rule: **core is what would exist with zero known hosts.** `core/` and `util/` import
nothing else in `src`. Runtime imports core, util, and runtime modules. Individual
providers import their own folder, util, the runtime's provider contract, and core's
delivery values/paths. They cannot import core API/store or runtime implementations.
The provider catalog, daemon, and clients compose the concrete implementations.
`bun run check` enforces these imports alongside types, lint, and tests.

## 3. The model

Core handles communication between agents that have a line. A *line* is whatever
accepts text for an agent, and someone holds it:

- For a discovered host (Claude Code, Codex, Aside) the provider holds the line: it
  knows how to find the session and push into it.
- For a registered process the process holds its own line: it calls `pull` on the
  daemon and messages are handed back through that call.

Core does not distinguish the two. `send` logs the message, invokes its injected
delivery function, records the outcome, and wakes anyone waiting. The runtime
supplies that function and chooses the provider connector. Providers never receive
the core API or store. The daemon's RPC boundary resolves sender identity.

## 4. Data model (`core/schema.ts`)

Only what must survive a daemon restart is stored: who the agents are and what was
said. Presence is re-observed every few seconds and lives in the provider manager's memory.

| Table | Row per | Columns |
|---|---|---|
| `agents` | agent | `id` (ours, permanent), `name` (display; follows the host's), `host` (which provider holds the line), `hostKey` (the host's own id, opaque to core, never a secret), `lastSeen` |
| `credentials` | registered agent | `secretHash` (sha-256 of its token secret), `createdAt`; the agent's auth secret, kept apart from its identity |
| `conversations` | pair | `kind = dm`, `key = dm:<sorted ids>` so there is one DM per pair |
| `participants` | conversation × agent | ready for groups |
| `messages` | message | `seq` (global order), `id` (short random; the read mark providers watch for), conversation, sender, body |
| `deliveries` | message × recipient | `status` (sent / delivered / read / failed), `detail` (why only sent, how delivered, or why failed), `readAt` |

Inbox state is per delivery row, not a per-agent cursor, so a scoped read or a
send-and-wait consumes one conversation without skipping others.

Schema changes: edit `schema.ts`, run `bun run migrate:generate`, commit the
migration. The store applies pending migrations on open.

## 5. Identity

- **Agent id**: ours, permanent, the only identifier in messages, logs, or `who`.
- **(host, hostKey)**: how the agent is recognized again. The provider chooses the
  key (Claude's session id, Codex's thread id, Aside's session id, or a minted
  non-secret id for a registered process). Same pair = same agent, across daemon
  restarts and host restarts that keep the host's identity (`--resume`,
  `codex resume`). Core compares keys and hands them back to the provider; it never
  interprets them. The key is never a secret.
- **Credential**: a registered agent also has a secret, stored only as a hash in the
  `credentials` table, separate from its key so it can rotate without changing
  identity. Its token is `<agent-id>.<secret>`: the id names, the secret proves.

Callers identify themselves on the RPC with one of:

| kind | fields | resolved by |
|---|---|---|
| `self` | host, key, name | `providerManager.identify`: bind by (host, key), record contact |
| `token` | id, secret | agent looked up by id (must be host `registered`); secret verified against its credential hash; record contact |

`identity.ts` decides which to send from inside a process: explicit `--as` (a
`self` identity on the pseudo-host `cli`, test only), then `MODELBUS_TOKEN`, then
`MODELBUS_HOST/KEY/NAME` (for hosts that run one shim for many sessions), then each
provider's `identifySelf()` (ancestor pids), then `MODELBUS_AS`.

The MCP shim binds a client once; it adds identity to every request outside model
tool arguments. The `self` path still accepts claims without verification; the
token path verifies a stored credential. Renaming providers does not fix that gap.

## 6. The provider interface (`runtime/provider.ts`)

```
Provider.host                           existing host namespace
Provider.discovery?                     Discovery object
  observe()                             -> Observation[]
Provider.connector?                     Connector object
  deliver(key, outbound, onRead)         -> { result: DeliveryResult, watch?: Watch }
  attach?(key, info)                     accept host runtime information
Provider.identifySelf?()                 -> SelfIdentity | null
Provider.configure?()                    -> ConfigurePlan

Secrets (handed to a provider at construction by the daemon)
  get(name) / set(name, value) / delete(name) / list()
```

`Secrets` is what the daemon remembers for one provider across restarts: values the
provider names and interprets. Each provider gets its own; it cannot see another's.
The implementation (`runtime/secrets.ts`) is one owner-only JSON file per provider
under `~/.modelbus/secrets/`, replaced whole through a temp file and rename. Core
has no part in it. Outside the daemon (CLI, shim) providers get no `Secrets`; they
only run setup and self-identification there.

This is a runtime contract, not a core port. Discovery, communication, identity
lookup, and setup are independent. A connector can exist without discovery, and
an application can register directly without supplying any provider implementation.
Built-in providers group their capabilities in one class to share host state.

An `Observation` is the key, the preferred name, the relationship (`top-level` |
`subagent` | `unknown`), reachability, and display facts (note, pid, cwd, status,
title). Only `top-level` observations become agents. Anything else a provider needs
at delivery time it re-derives from its host, keeps in its own memory (Aside's
session-to-account map), or asks the daemon to remember through `Secrets`.

`deliver` receives an `Outbound` (`core/delivery.ts`): the stored message row and
the sender's agent row. Core does not render text. The connector chooses the host's
form and, if it watches for the read mark, its own marker. The three built-in providers
all take plain text, so each calls `util/attribution.ts` for the default form:
`[modelbus #<id>] from <name>`, a blank line, the body unchanged; the marker is
`#<id>`. A host with richer input would not use it.

A message has four states per recipient. `send` returns after storage and the
push attempt, or throws on refusal. After that each recipient's copy is `sent`
(the daemon has it; nothing reached the recipient yet, `detail` says why), `delivered`
(the push was accepted by the recipient's host), `read` (the host transcript shows
it, or a pull returned it), or `failed` (the push was rejected; the recipient can
still pull). A provider's `DeliveryResult` is `delivered` or `failed`; `read` comes
later through `onRead`. "Pending", the sender holding a message the daemon has not
stored, exists only inside a client.

Two gaps, stated plainly. Between `delivered` and `read` the host can drop its
copy (Claude Code exiting with the message still queued); the daemon keeps the
message but nothing pushes it again. And a pull marks its items `read` as it hands
them back, so a connection dropped mid-response leaves them marked read and unseen.

## 7. The provider manager (`runtime/provider-manager.ts`)

`runtime/discovery.ts` exposes `discover(providers)`, which only observes. It
returns per-provider `observed` results (including empty observations) or `failed`
results with details. It does not register agents, call setup, or deliver messages.

Every 3 s, and on demand, the manager runs discovery and applies the POC's existing
automatic binding policy: each top-level observation is bound to an agent by
(host, key), with display facts kept in memory. Explicit session connection is a
documented direction, not yet a replacement for this policy. A throwing provider
keeps its previous presence. An
agent is live if its provider saw it on the last pass, or if it called in itself
within the last ten minutes (`touch`, from `identify` and token use). `deliver()`
routes to the agent's connector with its key; no provider or connector means
`sent` with detail `waiting for it to sync`. `list()` is the roster, reachable first.

Providers keep nothing running. A `deliver` that starts a transcript watch hands it
back as a `Watch` (`util/watch.ts`: closable, with a `done` promise). The manager
keeps every open watch, drops each as it finishes, and closes the rest in `stop()`
along with its own timer. This is the disposable-out shape plugin hosts use.

## 8. A send, end to end (`core/api.ts`)

1. RPC `send { to, body, wait? }` with an identity. The method table validates
   params, resolves the identity to the sender's agent id, and resolves the
   recipient's name to an id (after one reconcile pass if unknown). Core only
   ever sees ids; the "try who" wording belongs to the daemon.
2. Core looks both agents up by id.
3. Guards: body ≤ 64 KB, not identical to something the sender wrote in this DM in
   the last 60 s, sender under 10 sends per minute. Refusals are `ApiError` → 422.
4. Message + delivery row inserted in one transaction; an in-process event fires so
   long-polls wake.
5. Delivery via the injected `deliver` (the provider manager's). Status stored on the row.
   If the recipient is blocked in send-and-wait for a reply from this sender, the
   message is returned through that call instead of pushed.
6. Read is separate: the provider captured the host transcript's size before
   delivering and watches it (file change events) for a line containing its
   marker in the host's "user message" shape; then the row becomes `read`.
   A pull marks its items read.
7. With `wait`, the API blocks (up to 240 s) for the next message from the
   recipient in this DM and returns it inline.

`pull { scope?, wait?, limit? }` returns unread deliveries (oldest first, cap
50), marks them read, and reports `more` and `moreElsewhere`. It is the line
for pull-only recipients and the explicit catch-up (`sync`) for everyone else.

## 9. Hosts

| Host | Key | Observe | Deliver | Read | `init` writes |
|---|---|---|---|---|---|
| Claude Code | session id from `~/.claude/sessions/<pid>.json` | registry files with a live pid | post to the session's inbox socket via a short-lived helper, with the token if attached | `~/.claude/projects/.../<session>.jsonl`: `queue-operation remove` or a `user` entry | user settings: allow `mcp__modelbus__*`, SessionStart hook; `claude mcp add -s user` |
| Codex | root thread id (lock files held by the process; classified by state DB `thread_source`, rollout header, or single-lock rule) | `codex` processes on a tty | `codex queue --thread <id>` | rollout `response_item` user message | `codex mcp add`; `[mcp_servers.modelbus.tools.<t>] approval_mode = "approve"` |
| Aside | session id from `~/.aside/u/<N>/state.db` (account remembered in memory) | daemon health + state DB, last 7 days | `aside --account u<N> session queue <id>` | `~/.aside/u/<N>/sessions/<date>_<id>/messages.jsonl` user entry | each account's settings: `mcp.servers.modelbus` (env names the account) + cached tool inventory |
| registered | minted non-secret key | none: live by contact | none: sent until the process pulls | on pull | none |

Claude Code specifics: the token is consulted only if the posting process has
exited, hence the helper (`providers/claude-code/post.ts`, run as its own process).
The provider keeps each session's token in its `Secrets`, keyed by session id, so
a daemon restart does not lose it; on each observe it forgets tokens of sessions no
longer live (a resumed session re-attaches from its hook). Sessions started before
`init` are delivered "no token" until they run `attach` or a new shim starts and
attaches. Claude Code may ask the user before injecting without the token. The
SessionStart hook is `modelbus attach`. Whether a token stays valid across
`--resume` is untested.

Codex specifics: a thread with no turns yet cannot be queued to ("no rollout
found"), shown as not reachable. Codex reads config at launch; sessions started
before `init` prompt once per tool. Codex's shell sandbox blocks the daemon socket,
so the MCP shim is the only door from inside Codex.

Aside specifics: reads MCP settings at startup (restart after `init`). One shim per
account, so messages from Aside are attributed to the account (`aside-1`), not the
session. Aside declines browser actions "requested solely by another agent" on its
own policy.

## 10. Protocol and clients

RPC: POST `{ method, params, identity? }` to `~/.modelbus/daemon.sock` path `/rpc`.
Methods: `ping`, `bind`, `attach`, `register`, `send`, `pull`, `who`, `log`. The
method table in `daemon.ts` is the protocol; `client.ts` derives its types from it,
so `rpc("who", { filter })` is checked at compile time. See `protocol.md`.

Clients: the CLI (`send`, `sync`, `who`, `log`, `register`, `attach`, `init`,
`mcp`, `serve`); the MCP shim (`send`, `who`, and
`sync` only with `--with-sync`; one-sentence instructions); any program via the
socket. `MODELBUS_HOME` points clients at another instance. The CLI starts the
daemon on demand for every command that needs it.

## 11. Limits (`core/limits.ts`)

Every limit is an option with an exported default: `new Api(store, limits)` and
`createDaemon({ limits })` take a partial `Limits` and fill in `DEFAULT_LIMITS`.
Defaults: dedupe window 60 s, 10 sends per sender per minute, 64 KB body, 240 s max
wait (below Bun's 255 s socket idle timeout; the daemon checks this at startup),
50 items per pull. Nothing reads them from the environment or a config file yet;
that arrives with settings. Clients do not enforce them: the shim passes `wait`
through and the daemon caps it. Timings local to one module (reconcile interval,
socket timeouts, watcher polling) are named constants at the top of that module.
No wake budget, no hop counter, no contact policy in v0.
