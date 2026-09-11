# modelbus

A local message bus between coding-agent sessions. One daemon per user, TypeScript
on Bun, SQLite for durable identities and messages.

modelbus discovers Claude Code, Codex, and Aside sessions, delivers through
their native input mechanisms, and lets other processes join through registration.
Agents use a small MCP tool surface to send messages and find peers. A process
without a native delivery integration receives through `pull` / `sync`.

## Run

```sh
bun install
bun run src/cli.ts init          # describe host setup without writing it
bun run src/cli.ts init --write  # apply host configuration
bun run src/cli.ts start         # run the daemon as a login service (macOS); `serve` runs it in the foreground
bun run src/cli.ts who
bun run src/cli.ts send --to <name> "text"
bun run src/cli.ts tui           # live view of agents and messages; ? for keys, q to quit
```

Nothing starts the daemon for you; `start` is the one explicit act, `stop` undoes
it, `restart` bounces it after a code change. `modelbus web` serves an MCP endpoint
for web chats on localhost; expose it with a tunnel of your choice and add it to
claude.ai or ChatGPT as a custom connector.

Sending requires an identified session or registration credential. Host setup may
require restarting the host to load its tools. Claude's delivery token is kept by
the daemon across restarts and forgotten when the session ends.
After updating this source checkout, `modelbus restart` loads the changes.
Everything under `~/.modelbus` is readable by its owner only.

## Boundaries

- **Core:** agents, conversations, messages, delivery records, communication rules.
- **Runtime:** authentication boundary, provider management, presence, routing.
- **Providers:** host-specific discovery, communication, identity lookup, and setup.
- **Clients:** CLI, MCP shim, and applications using the daemon's protocol.

The runtime owns the provider contract. Discovery and communication are separate
optional capabilities; observing a host does not itself register agents. The POC
runtime lists discovered sessions as candidates until they register. Explicit connection
UX, provider settings, web integrations, icons, and a shared artifact board are
documented directions, not shipped features.

## Development

`bun run check` runs type checking, formatting/lint, layer checks, and tests. Tests
use disposable databases and Unix sockets; a restricted shell may need permission
to open the test sockets.

## Docs

- [Architecture](docs/architecture.md): the code and behavior that exist.
- [Runtime and providers](docs/runtime-and-providers.md): current design direction,
  rationale, implementation scope, and open questions from September 9.
- [Protocol](docs/protocol.md): register, authenticate, send, and receive from any process.
- [Handoff](docs/handoff.md): status and operational findings.
- [POC spec](docs/poc-spec.md) and [design notes](docs/design-notes.md): historical
  milestones and exploration; newer decisions are linked at the top.
- [Host research](docs/host-inventory-and-bus-design.md): the original survey.
