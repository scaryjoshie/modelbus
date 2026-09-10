# Joining modelbus from any process

modelbus detects Claude Code, Codex, and Aside sessions on its own. Anything else
joins by registering with the runtime. No provider implementation or discovery is
required. The current POC automatically binds discovered top-level host sessions;
explicit connection workflows are discussed in `runtime-and-providers.md`.

## 1. Register

```
modelbus register --name <name>
```

Prints a token on stdout, of the form `<agent-id>.<secret>`: the id names the agent,
the secret proves it. The daemon stores only a hash of the secret. Keep the whole
string in memory or in `MODELBUS_TOKEN`.

The client software holds this credential. An MCP-hosted model does not repeat it
in tool arguments: launch the shim with the credential in its environment, and the
shim attaches it automatically. Raw CLI examples below spell out `--token` for
clarity; `MODELBUS_TOKEN` also works across commands.

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

Identity is `{kind:"token", id, secret}` (a registered agent: the id names, the
secret proves) or `{kind:"self", host, key, name}` (a session naming itself; `key`
is provider-defined). Clients split the `<id>.<secret>` token string into those
two fields. The CLI's `--as <name>` is a `self` identity on the pseudo-host `cli`,
for testing.

The `self` path currently trusts the claim; only `token` verifies a secret. This
local POC protocol is not yet an authenticated cloud/provider-delegation protocol.

| method | params | identity | returns |
|---|---|---|---|
| `ping` | | no | `{ok, pid}` |
| `register` | `{name}` | no | `{agent, token}` |
| `bind` | | yes | `{agent}` |
| `attach` | provider-specific runtime info | yes | `{agent, attached}` |
| `send` | `{to, body, wait?}` | yes | `{message, to, delivery: {status, detail?}, reply?}` |
| `pull` | `{scope?, wait?, limit?}` | yes | `{items, more, moreElsewhere}` |
| `who` | `{filter?, fresh?}` | no | `{agents: RosterEntry[]}` |
| `log` | `{a?, b?}` | no | `{rows}` |

`delivery.status` is `sent` (the daemon has it and nothing reached the recipient
yet; `detail` says why), `delivered` (the recipient's host accepted the push), or
`failed` (the push was rejected; `detail` says why). `read` appears later in `log`,
when the host transcript shows the message or a pull returns it.

A message that is `sent` or `failed` is pushed again when its recipient becomes
reachable, so sending to a session that is closed, or to a Codex thread before its
first turn, needs no action from the sender. Two things the protocol does not yet
guarantee. A message can sit `delivered` forever if the host drops its copy;
nothing pushes it again, since the host may still hold it. And `pull` marks items
`read` as it returns them, so if the connection drops before the response arrives,
those items are marked read and were never seen. Errors come back as HTTP 4xx/5xx with `{error}`; 422 means
the request was refused by a guard or a name lookup.

From TypeScript, `src/client.ts` exports `rpc(method, params, identity?)` typed
against the daemon's method table. `createClient(identity)` binds that identity
once and exposes `request(method, params)`:

```ts
import { createClient, rpc } from "./src/client.ts";
import { parseToken } from "./src/identity.ts";

const registration = await rpc("register", { name: "my-app" });
const client = createClient(parseToken(registration.token));
await client.request("send", { to: "another-agent", body: "hello" });
const reply = await client.request("pull", { wait: 30 });
```

Registration, host configuration, and discovery are independent operations.
`attach` supplies host-specific delivery information; it does not install tools or
prove an unverified `self` identity. `send` accepts a recipient and body; its sender
is supplied by the runtime after identity resolution.

## From a web chat

`modelbus web` serves the same idea over HTTP for chats on claude.ai or ChatGPT:
`join { name }` registers the chat and returns its id; `send`, `sync`, and `who`
take that id as `as`. The chat repeats an id, never a secret. Expose the endpoint
with a tunnel and add it to the service as a custom connector. A web chat cannot
be woken: it receives when it calls `sync` or waits on a `send`.

## As an MCP server

Any MCP-capable host can run `modelbus mcp` as a stdio server with `MODELBUS_TOKEN`
(or `MODELBUS_HOST`/`MODELBUS_KEY`/`MODELBUS_NAME`) in its environment. The host then
has `send` and `who` tools (`sync` with `--with-sync`). Delivery into that host
still needs a push door of its own; without one, messages wait for `sync`.
