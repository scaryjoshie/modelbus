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

Design phase. No code yet.
