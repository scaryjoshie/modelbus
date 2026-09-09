# modelbus

A local message bus for coding agents.

Most coding-agent hosts (Claude Code, Codex CLI, Cursor, Gemini CLI, OpenCode, Goose, Cline, Copilot CLI, and others) can act as MCP clients, but almost none of them expose a reliable way to push a message *into* a running session. modelbus is a small, pull-first hub that gives every agent a stable name and an inbox, and layers host-specific "wake" delivery on top only where a host actually supports it.

## Design principles

- **Pull-first.** The universal adapter is an MCP server face exposing a `sync()` / `check_inbox()` tool with server-side cursors. Every MCP-client host can use it.
- **Push as an optimization, not a dependency.** Claude Code Channels, Agent SDK streaming input, OpenCode's `/tui` endpoint, OpenClaw `sessions_send`, and hook / `pre_llm_call` injection are layered on per host.
- **Loop protection by default.** Sender/source field for self-echo drop, identical-repeat dedupe, unread-queue cap (50), overflow drop-oldest (100), urgency tiers with a delayed normal-priority push, hop counter + TTL, busy-guard during active turns, and a ~64 KB per-message byte cap.
- **Explicit recipients.** No broadcast-to-everyone by default.
- **Local and boring.** SQLite on disk, per-agent names, no cloud, no daemon required for the basic path.

## Docs

- [`docs/host-adapter-inventory-and-bus-design.md`](docs/host-adapter-inventory-and-bus-design.md) — per-host inventory of push/hook/MCP/headless capabilities, survey of existing agent buses, loop-protection patterns, standards status (A2A / MCP 2026-07-28), and the recommended adapter per host.

## Status

Working POC: Claude Code, Codex, and Aside sessions exchange direct messages through
a local daemon, with no per-message prompts, and any process can join by registering.

```
bun install
bun run src/cli.ts init --write   # wires Claude Code, Codex, Aside (writes their configs)
bun run src/cli.ts who            # agents on the bus
bun run src/cli.ts send --to <name> "text"
```

Layout: `src/core` (store, api, guards, adapter interface), `src/daemon.ts` and
`src/tracker.ts` (the bus), `src/adapters/*` (one file per host plus self-registration),
`src/cli.ts` and `src/mcp.ts` (clients).

Docs:
- `docs/architecture.md` — how the code works: data model, identity, delivery, hosts.
- `docs/handoff.md` — current status, lessons learned, next-step candidates.
- `docs/protocol.md` — how any process joins the bus (register, send, receive).
- `docs/poc-spec.md` — the POC spec with milestones logged. A proposal, not a decision.
- `docs/design-notes.md` — the wider exploration; explicitly drafts, not decisions.
- `docs/host-adapter-inventory-and-bus-design.md` — external research report.
