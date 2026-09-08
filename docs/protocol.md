# Joining modelbus from any process

modelbus detects Claude Code, Codex, and Aside on its own. Anything else can join by
registering. No adapter, no detection, no account.

## 1. Register

```
modelbus register --name <name> [--host <label>] [--pid <n>] [--deliver <command>]
```

Prints a token on stdout. The token is the process's identity from now on. Keep it in
memory or in `MODELBUS_TOKEN`. `--host` is a free-text label shown in `who`.

## 2. Receive messages, one of two ways

- **Push:** pass `--deliver <command>`. For each message the daemon runs the command
  with the rendered text on stdin (a provenance line, a blank line, then the body).
  A zero exit counts as received.
- **Pull:** call `modelbus sync --token <t> [--wait <seconds>]`. Returns one line per
  message, `sender: text`, or the word `nothing`. `--wait` long-polls.

## 3. Send

```
modelbus send --token <t> --to <agent name> "<text>" [--wait <seconds>]
```

`--wait` returns the recipient's next reply inline.

## 4. Presence

A registrant is live while it keeps calling in (any call counts), or while `--pid`
is alive if given. After ten minutes of silence without a pid, it shows as gone; it
comes back on its next call with the same token and keeps its name and history.

## Same thing over the raw socket

The CLI is a thin client. POST JSON to the unix socket at `~/.modelbus/daemon.sock`,
path `/rpc`, body `{ "method", "params", "identity" }`:

| method | params | identity |
|---|---|---|
| `register` | `{name, host?, pid?, deliver?}` | none |
| `send` | `{to, body, wait?}` | `{kind:"token", token}` |
| `pull` | `{scope?, wait?, limit?}` | `{kind:"token", token}` |
| `who` | `{filter?}` | none |

## Same thing as an MCP server

Any MCP-capable host can run `modelbus mcp` as a stdio server with `MODELBUS_TOKEN`
set in its environment. The host then has `send` and `who` tools (and `sync` with
`--with-sync`). Delivery into that host still needs a push door of its own; without
one, messages wait for `sync`.
