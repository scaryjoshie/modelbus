# Handoff (written 2026-09-08 by the Claude session that built the POC)

Read `architecture.md` for how the code works. This file is what you need to know
that isn't in the code.

## Where things stand

- The POC is done and verified live: Claude Code, Codex, and Aside sessions each
  receive messages from the bus with no per-message prompts and reply through the
  modelbus `send` tool; a shell script joined via `register` and round-tripped too.
  Every check (`bun run check`) passes. Everything is pushed to
  `scaryjoshie/modelbus`.
- Joshua's machine is fully wired: `init --write` has been run for all three hosts.
  The Aside CLI is installed at `~/.local/bin/aside`. The daemon runs from source
  (`bun run src/cli.ts serve`) and clients auto-start it. A daemon restart forgets
  Claude Code tokens; sessions recover on their next shim call or `attach`.
- Codex sessions that predate `init` still prompt once per MCP tool; new ones don't.
  Aside had to be restarted to load the MCP server.

## What Joshua wants (do not relitigate)

- **Minimal.** This is a communication layer, not orchestration. No rules,
  policies, or instructions unless a model demonstrably needs them. Watch what
  models do with a bare message first. He objected, rightly, to a header full of
  instructions and to me proposing introductions/contact policy/wake budgets.
- **Models never poll.** The bus delivers through each host's own door. `sync`
  exists only as explicit catch-up. A heartbeat routine was proposed for Aside and
  withdrawn; the Aside CLI is the right door and he approved installing it.
- **Object model.** Uniform `Agent` (our id/name/host/state); host identity sealed
  in the adapter's handle; core never reads it. He asked for this explicitly after
  spotting "session id" as a leaky abstraction.
- **Registration for any process** (done) so integrations don't all need detection
  code. He sees detection adapters as living *on top of* the core and possibly
  registering through the same API as apps.
- **Docs are drafts.** `design-notes.md` is exploration; OPEN items are undecided.
  Ask before resolving one. He rewound the conversation once when a branch went
  further than he wanted.
- **Code quality matters to him** and he's learning TypeScript; he asked whether the
  code is idiomatic. Conventions are in CLAUDE.md. Keep files small, results typed,
  no host names outside adapters.
- **He last said**: the strict separation of object types may be costing convenience
  and simplicity, and he wants to revisit that. That conversation is next.

## Lessons that cost real time

- Claude Code delivers an own-child message with the token **only if the posting
  process has already exited**; a long-lived poster is held behind a dialog even
  with the token. Hence `postViaHelper`.
- Claude Code records a delivered peer message as either `queue-operation remove`
  or a plain `user` entry; watch for both.
- `codex queue` fails on a thread with no turns ("no rollout found").
- Codex's state DB must be opened with `?immutable=1` or a read-only connection
  fails when the WAL sidecar is absent.
- Codex's exec sandbox blocks unix sockets: the CLI cannot reach the daemon from
  inside Codex; the MCP shim (spawned unsandboxed by Codex) is the door.
- Aside reads `settings.json` MCP servers only at startup and only offers a server's
  tools if `mcp.inventories.<name>` holds a cached tool inventory; `init` writes it.
- Aside runs one MCP shim per account; nothing in its environment names the session,
  so Aside's outbound identity is per account. Untested: whether the MCP tool-call
  metadata carries a session id (would need a debug shim and an Aside restart).
- Aside refuses browser actions requested by another agent, with or without our
  header. That's Aside's policy; it needs Joshua's authorization on Aside's side.
- Terminal injection is inherently terminal-specific on macOS (TIOCSTI is denied to
  users). All of that code was removed; every host has a native door.
- Shell gotcha: zsh doesn't word-split `$VAR`; use a function. Commit messages with
  `<...>` inside double quotes broke; use `-F file`.

## Live sessions Joshua uses

Names are the agent names on the bus. His Codex review session is titled "Review
concept feasibility" (was `codex-2`; Codex renames after the first turn). This
Claude session was `modelbus-8f`. A second Claude session `modelbus-ca` and extra
Codex sessions were started by me for tests, in cmux tabs in his MODELBUS workspace;
he may close them.

## Candidate next steps (his call)

1. Revisit the object-type separation for convenience (his open concern).
2. Aside session identity via tool-call metadata; then `send --wait` matches Aside
   replies to the session they came from.
3. Tokens surviving a daemon restart (owner-only file keyed by session id).
4. Package split (core / adapters / client / cli), compiled daemon, launchd.
5. Webhook delivery option for registered apps (`--deliver-url`).
6. Groups, UI, federation: designed in `design-notes.md`, not built.
