# Joining modelbus from any process

modelbus detects Claude Code, Codex, and Aside sessions on its own. Anything else
joins by registering. No adapter, no detection, no account.

## 1. Register

```
modelbus register --name <name> [--host <label>] [--pid <n>] [--deliver <command>]
```

Prints a token on stdout. The token is the process's identity from now on; keep it
in memory or in `MODELBUS_TOKEN`. `--host` is a free-text label shown in `who`.

## 2. Receive, one of two ways

- **Push:** pass `--deliver <command>`. Per message the daemon runs the command with
  the text on stdin: an attribution line `[modelbus #<id>] from <name>`, a blank
  line, the body. Exit 0 counts as received.
- **Pull:** `modelbus sync --token <t> [--wait <seconds>]`. One line per message,
  `sender: text`, or the word `nothing`. `--wait` long-polls.

## 3. Send

```
modelbus send --token <t> --to <agent name> "<text>" [--wait <seconds>]
```

`--wait` returns the recipient's next reply inline.

## 4. Presence

A registrant is live while it keeps calling in, or while `--pid` is alive if given.
After ten minutes of silence without a pid it shows as gone; the same token brings
it back with its name and history.

## The wire protocol

The CLI is a thin client. POST JSON to the unix socket `~/.modelbus/daemon.sock`
(`MODELBUS_HOME` overrides the directory), path `/rpc`:

```
{ "method": "...", "params": { ... }, "identity": { ... } }
```

Identity is one of `{kind:"token", token}`, `{kind:"self", host, key, name, evidence?}`
(a session naming itself; `key` is host-adapter defined), or `{kind:"cli", as}` (test only).

| method | params | identity | returns |
|---|---|---|---|
| `ping` | | no | `{ok, pid}` |
| `register` | `{name, host?, pid?, deliver?}` | no | `{agent, token}` |
| `bind` | | yes | `{agent}` |
| `attach` | adapter-specific runtime info | yes | `{agent, attached}` |
| `send` | `{to, body, wait?}` | yes | `{message, to, delivery: {outcome, detail?}, reply?}` |
| `pull` | `{scope?, wait?, limit?}` | yes | `{items, more, moreElsewhere}` |
| `who` | `{filter?, fresh?}` | no | `{agents: RosterEntry[]}` |
| `log` | `{a?, b?}` | no | `{rows}` |

`delivery.outcome` is `delivered`, `delivered-unattested`, `waiting`,
`returned-to-waiter`, `unavailable`, or `error`. Errors come back as HTTP 4xx/5xx
with `{error}`; 422 means the request was refused by a guard or a name lookup.

## As an MCP server

Any MCP-capable host can run `modelbus mcp` as a stdio server with `MODELBUS_TOKEN`
(or `MODELBUS_HOST`/`MODELBUS_KEY`/`MODELBUS_NAME`) in its environment. The host then
has `send` and `who` tools (`sync` with `--with-sync`). Delivery into that host
still needs a push door of its own; without one, messages wait for `sync`.
