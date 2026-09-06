# modelbus design notes

> **STATUS: EXPLORATORY DRAFT. NOTHING IN THIS FILE IS A DECISION.**
>
> These are ideas from design conversations between Joshua and Claude, September 2026.
> Many are unfinished, several contradict each other on purpose, and some will turn
> out to be wrong. Items marked **OPEN** are explicitly undecided. Items marked
> **LEANING** are the current preference but are not settled.
>
> **If you are an agent implementing modelbus:** do not treat this document as a spec.
> Before making any design choice that touches something described here, ask Joshua.
> Do not resolve an OPEN item on your own. Do not "just pick something reasonable."
> When in doubt, stop and ask.

---

## 1. What modelbus is for

A local message bus so coding agents (Claude Code, Codex, Cursor, Gemini CLI, OpenCode,
Goose, Cline, Copilot CLI, Aside, and others) can talk to each other on one machine,
with an orchestrator on top that Joshua can talk to.

The motivating goal is connecting three kinds of agent through one envelope:
terminal coding agents, MCP-driven tools, and browser / computer-use agents (Aside
specifically).

### Hard constraints

- **Hidden.** Nothing modelbus does may move the mouse, click, steal focus, raise a
  window, or pop anything onto the screen while Joshua is working. Activity inside an
  agent's own terminal pane or inside a browser agent tab is fine. Keystroke injection
  via System Events, macOS notifications, and window activation are all excluded.
- **Light.** Tiny tool surface, near-zero context cost when idle, no heavy dependencies.
- **Not account based.** No login, no cloud identity. Local names plus a reclaim token.
- **Local-first.** One machine, localhost only, SQLite on disk. Cloud is a future layer
  (section 12), not a v0 concern.
- **Don't overdevelop.** A first version may be direct messaging only.

### Prior art

`docs/host-adapter-inventory-and-bus-design.md` is the research report this started
from. Key conclusion: only Claude Code has a real push-into-session primitive and it is
unreliable, so the hub must be pull-first with push layered per host.

`agent-bus-mcp` (alessandrobologna, MIT) has the right primitives in its `spec.md`:
topics, per-topic monotonic `seq`, server-side cursors keyed by (topic, agent_name),
one read/write `sync()` tool with long-polling, `client_message_id` idempotency key,
and a `reclaim_token` so an agent can reclaim its name after restart. We should borrow
those concepts and credit the author. We should not fork the code (Rust extension for
embeddings, three package ecosystems, read-only web UI). It has no direct addressing,
no priority, no wake delivery, and no loop protection, which is exactly the delta
modelbus adds.

`claude-peers-mcp` (jamditis) is the reference for tmux-paste delivery, urgency tiers,
and holding a message when the pane's foreground process is a bare shell.

---

## 2. Architecture (LEANING)

**One daemon, one port, one SQLite file.** `modelbus serve` owns the database and
exposes on localhost: MCP over streamable HTTP, the web UI, and the delivery adapters.
A thin `modelbus mcp` stdio shim proxies to it for hosts that only speak stdio and
auto-starts the daemon if needed.

Rationale over the no-daemon shared-file model: wake delivery, the presence detector,
and the orchestrator all need a long-running process with OS access. One process is
simpler than N stdio servers plus a separate web server.

**Language: TypeScript on Bun.** Bun has builtin SQLite, HTTP server, and shell runner.
MCP reference SDK and Claude Agent SDK are TypeScript-first. The web UI is first class
and shares the language. Conventions: Bun defaults, `strict: true`, ESM only, Biome for
format and lint, zod at boundaries, otherwise whatever idiomatic TypeScript encourages.
Joshua is more familiar with Python and is learning TypeScript; keep code legible.

**Web UI is first class** and must be able to write (send messages, talk to the
orchestrator), unlike agent-bus-mcp's read-only viewer. Envisioned as a graph of all
active agents, with un-integrated ones shown gray, and a way to ask the orchestrator
to integrate them.

---

## 3. Connecting an agent (LEANING)

Layered, cheapest first:

1. **CLI on PATH.** `modelbus send --as codex-1 --to ... "..."` works from any agent
   that can run a shell, zero per-host config. Costs no context until used.
2. **MCP** is the same thing with a typed schema and long-polling that doesn't fight
   shell timeouts. One `claude mcp add` / `codex mcp add` per host, done by
   `modelbus init`.
3. **Behavior text** (when to sync, how to address) travels with the MCP connection:
   the `instructions` string in the initialize handshake plus tool descriptions. Every
   host gets it. No per-repo skill file needed. `modelbus init` can also write a short
   block into each host's global instructions file for hosts that ignore MCP
   instructions. For Claude Code, a plugin can bundle skill + MCP + hooks.

**Onboarding:**
- `modelbus init` once per machine: detects installed hosts, writes MCP config into
  each, installs Claude Code hooks (SessionStart / Stop drain inbox).
- `modelbus run <host> [--as name] [--at path]`: opens a tmux pane, starts the host,
  sets the agent name in env so the MCP server pre-registers it, records the pane for
  wake delivery. Solves identity, wake, and behavior injection in one command.
- Unlaunched hosts connect on their own and register on first `sync`.

**Presence detector (LEANING):** the daemon polls the process table and tmux for
known host binaries and their cwd, and reads Claude Code's on-disk session registry.
This gives "what's running, where, reachable or not" for the UI and orchestrator.
Discovery is not membership: a detected process can pull if init was run but can't
be pushed to unless a delivery adapter reaches it. `modelbus adopt <pid>` resolves the
best adapter for a gray node; for pull-only nodes, the daemon can drop the behavior
snippet into that agent's cwd so its *next* session comes up integrated.

---

## 4. Tools (OPEN, but must stay tiny)

Every MCP tool schema sits in the agent's context every turn. Four terse tools is a few
hundred tokens; twenty is a problem. Richer operations belong in the CLI.

Candidate surface:
- `sync` — the one tool an agent must know. Sends an outbox, returns new inbox messages
  and roster deltas since the agent's cursor, long-polls, and on first call acts as
  registration (see section 7). Also carries `about` updates.
- `send` — may just be `sync` with an outbox; OPEN whether it deserves its own tool.
- `who` — full roster for the agent's scope, on demand.
- `read` / `search` — read a path's or thread's log on demand (section 9).
- connect / disconnect — OPEN whether explicit or folded into `sync` + presence expiry.
- talk to orchestrator — probably just `send` to a well-known address, not a tool.

Text output format matters as much as tool count: one line per message
(`codex-1 -> you: token refresh done, please review`), one line per roster change,
a single word when idle. No JSON in the text the model reads; structured content goes
in MCP's structured field for hosts that use it.

---

## 5. Delivery cascade (LEANING)

Delivery is a chain of strategies per agent, tried in order, first success wins. Each
strategy is one file that registers itself. The daemon records which strategy actually
delivered, and a strategy that fails repeatedly for an agent is demoted.

1. **Native push:** Claude Code cross-session messaging socket, OpenCode HTTP API,
   Claude Agent SDK streaming input, OpenClaw `sessions_send`.
2. **Headless turn:** spawn or resume a turn: Codex `exec resume`, Goose run, Gemini
   non-interactive. (Aside has its own path, section 11.)
3. **Terminal injection:** tmux paste (bracketed paste into the agent's pane, only
   after checking the pane's foreground process is the agent and not a bare shell),
   then iTerm2 / Terminal.app write-to-tab via AppleScript (does not raise the window).
4. **Hook piggyback:** for hosts with lifecycle hooks, the next hook drains the inbox.
5. **Pull only:** wait for the agent's next `sync`.

**Priority decides how far down the chain to go.** Normal priority stops at tier 5.
Wake priority tries 1 through 3. A normal-priority message may get a delayed push
(claude-peers-mcp uses 2 minutes) so recipients can drain cheaply.

Excluded under the hidden constraint: System Events keystrokes, notifications, anything
that opens or raises a window.

First adapters to build (LEANING): tmux paste (universal, dumb, proven), then Claude
Code socket and Agent SDK stream, then OpenCode HTTP.

---

## 6. Loop protection defaults (LEANING, numbers borrowed from shipping projects)

- Per-message sender/source field; drop self-echo.
- Identical-repeat dedupe within a short window.
- Per-sender rate limit; refuse bursts up front rather than accept-then-drop.
- Unread inbox cap 50, separate overflow of ~100 drop-oldest (Claude Code's numbers).
- Hop counter + TTL on relayed messages (hub-original; suggest max 4–8 hops).
- Busy-guard: hold delivery during an agent's active turn.
- Per-message byte cap ~64 KB (mcp-dispatch).
- Acks that do not wake the recipient; explicit terminate instead of chatty farewells
  (lesson from Claude Code agent-teams idle-notification ping-pong).

All constants in one file.

---

## 7. Identity, registration, naming (LEANING with OPEN parts)

Two layers, as every chat system converges on:

| Layer | Example | Uniqueness | Lifetime |
|---|---|---|---|
| id | `a_7f3k2` | global, never reused | permanent |
| name | `codex-1` | among live agents in scope | until expiry |

Messages store the id; everything agents read and write uses the name. `about` is a
separate one-line self-description the agent maintains; the roster also carries facts
the daemon gets for free (host kind, cwd, git repo/branch, last seen). Keep names
boring and stable; put role in `about`, because roles change mid-session.

**Registration is the first sync.** Agents register themselves (the alternative is
manual setup per session). If the agent arrives with a name (from the launcher env),
it keeps it. If it arrives without one, it gets one assigned at that moment. Names are
not pre-assigned by the daemon otherwise. Reclaim token stored by the launcher restores
identity and cursor after restart.

**Pruning is state, not deletion.** No sync for ~30 min = offline (gray). ~24 h =
archived, name released. Records and messages persist.

**OPEN:** should ids embed a device id from day one so cloud federation (section 12)
doesn't require a migration? Leaning yes.

---

## 8. Addressing and organization (OPEN — the biggest open question)

Two models were discussed.

**Buses (many-to-many).** A bus is a namespace with id and name; channels live inside;
an agent may be in many buses. Universal and flexible. Problems Joshua raised: hard to
visualize, agents in many buses become unmanageable, bus creation/pruning over time
gets messy even for models, and per-git-repo default buses are wrong (worktrees should
be independent; cross-repo work should be linkable).

**Filesystem-like hierarchy (LEANING).** Every agent has exactly one home path, e.g.
`/modelbus/backend/codex-1`. Global root, grouped into projects, subdivided as needed.
Addressing a path delivers to everything under it, so DM (leaf), group (directory),
and broadcast (root) are one mechanism. The tree is easy to visualize, there is no
"which buses am I in" problem, and `mv` reorganizes. Anyone can message any path;
membership is not required to send. Organization is fully custom, not derived from
git repos.

The concern with the hierarchy is conversation logs: a DM between `/a/x` and `/b/y`
has no single home. Possible resolution: **filesystem for addressing and membership,
threads for conversation logs.** Every message carries a thread id; a thread's log is
the messages sharing it regardless of paths. Path logs (everything sent to a path or
below) are a prefix query on a string column. Both are trivial in SQLite. Whether this
actually resolves the concern is OPEN.

Other OPEN items here:
- Placement: who decides where a new agent lives? Options: launcher flag `--at`, a
  cwd-to-path mapping rule, the orchestrator, or the agent proposing a location after
  looking at the tree. Leaning: agents do not self-place arbitrarily; default to
  `/unsorted/<name>` until placed by user, rule, or orchestrator.
- Visibility: can agents see the whole tree and every agent? Leaning: default scope is
  your own subtree, full tree available on request, orchestrator and UI see everything.
- Cross-cutting groups spanning paths: symlinks / mounts, or just threads? OPEN.
- A central "general" channel: probably the project root path. Rules discussed for it:
  cannot wake anyone, tighter rate limit, digest mode on busy projects.
- Mentions inside a group message (`@codex-1`) escalating to wake for that member.

**v0 may skip all of this** and do direct messaging with a flat root only. If `to` is a
path string from day one, depth can be added later without a schema change.

---

## 9. Delivery vs. visibility (LEANING)

- **Delivery is always explicit.** Every message names a recipient path. There is no
  "send to everyone" except by addressing the root, which the general-channel rules
  restrict.
- **Visibility is wide.** Any agent in scope can read any log and search across them.
  One user's machine; no privacy concern between their own agents; large upside for
  catching up on context. Reading is a tool call, so it costs nothing until used.

---

## 10. Orchestrator (LEANING)

The orchestrator is **not part of the core API**. It lives on top and uses the same
tools as any agent, with two privileges: it sees everything, and it can request a wake
on any peer. v0 orchestrator is zero custom code: a Claude Code session (or Agent SDK
loop) with a system prompt saying its job is coordination, which Joshua talks to in
its own terminal. Later the web UI gets a chat box that sends to it at wake priority.

Join events go to a lobby address the orchestrator watches; other agents are not
pinged about joins.

---

## 11. Aside (findings from local inspection, September 2026)

Aside is a Chromium-based AI browser (YC F25, launched June 2026). Findings below come
partly from public docs and partly from inspecting the daemon binary, its SQLite
schema, and local ports on Joshua's machine. **The undocumented parts may change
without notice.** Joshua's stated interest is interacting with *existing* Aside
sessions, not creating new ones, and they prefer not to use the Aside CLI.

Documented surfaces (docs.aside.com/help/developers):
- `aside "task"` starts a session; `aside --session <id> "msg"` continues one.
- `aside mcp` exposes Aside as an MCP server.
- `aside repl` runs Playwright-style browser scripts.
- CLI installs to `~/.aside/cli` with a symlink in `~/.local/bin`. Not installed on
  Joshua's machine as of writing, by choice.

Observed locally (undocumented):
- A separate `aside-daemon` process listens on localhost (port 21420 at the time) and
  is the real control plane; the CLI is a thin client of it. Auth is a
  challenge-and-sign handshake, not a static token. Do not reimplement it.
- Steering into a live session is first class in the daemon: sessions table has
  `queued_messages` and `steering_messages` columns; settings `followUpBehavior` is an
  enum of `queue` | `steer`; daemon procedures include `sessions.add`,
  `sessions.interrupt`, `sessions.abort`, `sessions.resolveSuspension`. This is
  implemented in Aside's own agent loop, so it is model-independent.
- **Aside is an MCP client** as well as a server: settings has an `mcp.servers` map
  and the daemon has an MCP HTTP router. So Aside sessions could call modelbus `sync`.
- Routines have four kinds: `cron`, `schedule`, `event`, `heartbeat`. A heartbeat
  routine targets an existing session and "wakes an existing chat and continues it."
  An event routine fires on a web notification from a granted origin.
- Sessions bind to a real browser tab (`browser_binding`, `active_tab_target_id`).

**Aside adapter idea (LEANING, untested):** MCP client for pull; heartbeat routine for
periodic wake of an existing session; event-triggered routine (hub serves a localhost
page that fires a notification) for urgent wake. All three are Aside features
configured in Aside, nothing driven from outside. No CLI, no daemon API.

**Planned experiment (not yet run):** register a stub `sync` MCP server in Aside's
settings and create one heartbeat routine on an idle session. This tests whether Aside
actually connects to a local MCP server, whether a heartbeat wake runs a full turn with
tool access, what is visible on screen when it does, and whether it fires without the
browser window focused. The event-routine path is tested after that.

---

## 12. Cloud / federation (FUTURE, discussed briefly)

Two layers of *daemon*: a local daemon per device (owns that device's agents and
delivery adapters) and a global relay that routes between devices. Two layers is
enough. For the *LLM* orchestrator, one global one is more apt than one per layer.

Consequences to avoid painting into a corner now: agent ids should be globally unique
(embed a device id), the local daemon stays the sole authority for its device, and
addresses may gain a device prefix (fits the path model: `/laptop/...`). Nothing else
should be built for this in v0.

---

## 13. Open questions (collected)

- Filesystem hierarchy vs. buses (section 8), and whether threads resolve the log
  concern.
- Placement of new agents in the tree; whether agents can self-place or self-join.
- Default visibility scope.
- Whether `send` is its own tool or just `sync` with an outbox.
- Explicit connect/disconnect tools vs. presence expiry.
- Device id in agent ids from day one.
- Everything in section 11 marked untested.
- What v0 actually includes. Leaning: register/sync, direct messages, tmux-paste
  wake, loop guards, the presence detector, and a minimal writable web UI. Possibly
  less.
