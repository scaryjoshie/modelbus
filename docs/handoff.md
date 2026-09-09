# Handoff (written 2026-09-08, updated 2026-09-09, by the Claude session that built the POC)

Read `architecture.md` for how the code works. This file is what you need to know
that isn't in the code.

## Where things stand

- The POC is done and verified live: Claude Code, Codex, and Aside sessions each
  receive messages from the bus with no per-message prompts and reply through the
  modelbus `send` tool; a shell script joined via `register` and round-tripped too.
  Every check (`bun run check`) passes. Everything is pushed to
  `scaryjoshie/modelbus`.
- 2026-09-09: identity/schema cleanup (see architecture.md §3–§5), typed RPC client,
  named constants, max wait lowered to 240 s to fit under Bun's socket idle timeout.
  Database was wiped and the daemon restarted; nothing of value was in it.
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
- **Object model.** An agent is our id + name + (host, hostKey). Core compares keys
  and hands them back to the adapter; it never interprets them. The 2026-09-09
  cleanup removed the sealed "handle", the `handles` and `presence` tables, and the
  durability/evidence/attestation metadata: they weren't read by anything. Don't
  reintroduce stored fields nothing consumes.
- **Discovered and registered agents are the same thing to core.** Someone holds
  each agent's line: an adapter for a discovered host, the process itself (via an
  open `pull`) for a registered one. Core never runs a command on an agent's behalf;
  the `--deliver <command>` option was removed for that reason.
- **Docs are drafts.** `design-notes.md` is exploration; OPEN items are undecided.
  Ask before resolving one. He rewound the conversation once when a branch went
  further than he wanted.
- **Code quality matters to him** and he's learning TypeScript; he asked whether the
  code is idiomatic. Conventions are in CLAUDE.md. Keep files small, results typed,
  no host names outside adapters.
- **Groups and read receipts are intended.** Conversations, participants, and
  per-recipient delivery rows stayed for that reason; `receivedAt` is the receipt.

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

1. Aside session identity via tool-call metadata; then `send --wait` matches Aside
   replies to the session they came from.
2. Tokens surviving a daemon restart (owner-only file keyed by session id).
3. Package split (core / adapters / client / cli), compiled daemon, launchd.
4. A `rename` verb (user-pinned names; `nameSource` was dropped with it).
5. Groups, UI, federation: designed in `design-notes.md`, not built.
