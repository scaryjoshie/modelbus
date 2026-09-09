# Joining modelbus from any process

modelbus detects Claude Code, Codex, and Aside sessions on its own. Anything else
joins by registering. No adapter, no detection, no account.

## 1. Register

```
modelbus register --name <name>
```

Prints a token on stdout. The token is the process's identity from now on; keep it
in memory or in `MODELBUS_TOKEN`.

## 2. Receive

```
modelbus sync --token <t> [--wait <seconds>]
```

One line per message, `sender: text`, or the word `nothing`. With `--wait` the call
blocks until a message arrives (up to 240 s); a process that keeps one such call
open receives as it happens. There is no push into a registered process: its open
call is its line.

## 3. Send

```
modelbus send --token <t> --to <agent name> "<text>" [--wait <seconds>]
```

`--wait` returns the recipient's next reply inline.

## 4. Presence

A registrant is live while it keeps calling in. After ten minutes of silence it
drops off `who`; the same token brings it back with its name and history.

## The wire protocol

The CLI is a thin client. POST JSON to the unix socket `~/.modelbus/daemon.sock`
(`MODELBUS_HOME` overrides the directory), path `/rpc`:

```
{ "method": "...", "params": { ... }, "identity": { ... } }
```

Identity is `{kind:"token", token}` or `{kind:"self", host, key, name}` (a session
naming itself; `key` is host-adapter defined). The CLI's `--as <name>` is a `self`
identity on the pseudo-host `cli`, for testing.

| method | params | identity | returns |
|---|---|---|---|
| `ping` | | no | `{ok, pid}` |
| `register` | `{name}` | no | `{agent, token}` |
| `bind` | | yes | `{agent}` |
| `attach` | adapter-specific runtime info | yes | `{agent, attached}` |
| `send` | `{to, body, wait?}` | yes | `{message, to, delivery: {outcome, detail?}, reply?}` |
| `pull` | `{scope?, wait?, limit?}` | yes | `{items, more, moreElsewhere}` |
| `who` | `{filter?, fresh?}` | no | `{agents: RosterEntry[]}` |
| `log` | `{a?, b?}` | no | `{rows}` |

`delivery.outcome` is `delivered`, `delivered-unattested`, `waiting`,
`returned-to-waiter`, `unavailable`, or `error`. Errors come back as HTTP 4xx/5xx
with `{error}`; 422 means the request was refused by a guard or a name lookup.

From TypeScript, `src/client.ts` exports `rpc(method, params, identity?)` typed
against the daemon's method table.

## As an MCP server

Any MCP-capable host can run `modelbus mcp` as a stdio server with `MODELBUS_TOKEN`
(or `MODELBUS_HOST`/`MODELBUS_KEY`/`MODELBUS_NAME`) in its environment. The host then
has `send` and `who` tools (`sync` with `--with-sync`). Delivery into that host
still needs a push door of its own; without one, messages wait for `sync`.
