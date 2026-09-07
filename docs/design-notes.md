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

**Premise: stop being the meat proxy.** Joshua runs many AI tools on one machine
(Claude Code, Codex, Cursor, Aside browser, and others) and currently relays context
between them by hand. modelbus is a communication layer so those tools can talk to
each other directly. The original trigger was letting the Aside browser talk to
Claude Code. The scope is deliberately bigger than that, but the premise stays.

**What it is not.** Not orchestration software. It does not run agents, assign work,
or replace anyone's favorite tools. Use whatever tools you like; modelbus only connects
their comms. It would be easy to turn into an orchestrator by adding chats, and that is
explicitly not the point. Joshua is a first-class participant on the bus (the web UI is
their seat, see section 10); an LLM orchestrator is optional, later, and if it exists it
is just another agent living high in the tree.

Why a bus instead of mounting one tool's MCP server in another: that gives one
direction (Claude Code drives Aside as a tool). A bus gives symmetry (Aside can
initiate toward Claude Code) and persistence (a conversation either side can pick up
later). Those two properties are the value.

The motivating first milestone: Aside and Claude Code exchange messages in both
directions through the bus with nothing appearing on screen.

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

**Layers, each usable without the ones above it (LEANING):**

1. *Protocol* — thread and message schema, the three MCP tools, the CLI. Could be
   implemented against a different daemon.
2. *Daemon* — store, cursors, delivery cascade, loop guards.
3. *Providers* — per-host detection, MCP config, wake adapters, needs-attention,
   focus. The detection piece is useful on its own.
4. *Organization* — folders, projects, scoping. Optional overlay (section 8).
5. *Policy* — the switches: orchestrator on/off, contact manual/open, project
   scoping on/off.
6. *Clients* — the web UI and any orchestrator are clients of the daemon.
7. *Federation* — pairing daemons across machines and people (section 12).

The simplest flow (open the UI, see every agent on the machine, link a few) needs
layers 1–3 and 6 only.

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

**Onboarding is opt-in per provider.** `modelbus init` detects installed hosts
(Claude Code CLI, Claude desktop app, Codex, Cursor, Gemini, OpenCode, Aside, ...) and
the user opts each one in. Each provider is one module (section 13) that knows how to
detect itself, write its MCP config, deliver wakes, report needs-attention, and focus
its window.

**Onboarding:**
- `modelbus init` once per machine: detects installed hosts, lets the user opt in per
  provider, writes MCP config into each, installs Claude Code hooks (SessionStart /
  Stop drain inbox).
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

## 4. Tools and message schema, from the model's perspective (LEANING)

Every MCP tool schema sits in the agent's context every turn. Three terse tools is a
few hundred tokens; twenty is a problem. Richer operations belong in the CLI.

Design principle: **the model-facing schema is tiny; everything else is internal.**
Models should never set hop counts, TTLs, idempotency keys, or priority tiers.

### Model-facing tools (three) — revised 2026-09-06: conversations, not threads

**Superseded:** the earlier thread-id design (models reply by `[t_k3f]` handles). It
risked handle sprawl. Replaced by the chat-app model: **one conversation per
participant set.** A *DM* is the single conversation between two agents, forever. A
*group* is a named conversation with members. Models never see a conversation id.

- `sync(scope?, all?, wait?)` — registration on first call. Returns what is new for me:
  DMs in full, groups as a one-line digest with @mentions of me in full. `scope` is an
  agent name or `#group` to read just that conversation; `all: true` returns recent
  history instead of only new. Long-polls up to `wait`. One word when idle. A line
  cap with "more" so no call can flood context.
- `send(to, body, wake?, wait?)` — `to` is an agent name (continues the DM), a
  `#group`, or a list of names (creates a group on the fly with an auto name that can
  be renamed). `wake` requests louder delivery if the provider allows. `wait: N`
  blocks for the next reply in that conversation and returns it inline.
- `who(filter?)` — agents and groups in scope, one line each; a resolver for "the
  browser", "the Codex in this repo".

**Wake defaults:** DM = queue-wake. Group = muted (delivered on next sync, no wake).
`@name` inside a group message wakes that member. Explicit `wake` overrides either.

Optional, never required: quote-reply to a message id for the rare sub-topic case.

### What the model reads

```
aside-1: Deploy verified; login page 500s on Safari. Screenshot at ~/aside/tasks/8Mq/shot.png
#deploy: 3 new, 1 mentions you
  codex-2: @claude-1 can you check the auth migration?
+ codex-2 joined, ~/dev/modelbus
```

No JSON in text output. Structured content can go in MCP's structured field for hosts
that use it.

### Message fields

**OPEN: envelope shape.** "Tiny" refers only to the model-facing surface; the stored
envelope is a separate choice, since models never see it. Two options:
1. Own envelope internally; A2A only at the federation boundary with a mapping layer.
2. **A2A-compatible envelope internally, own transport** (Claude's leaning once the
   teammate case became explicit): field names and structure follow A2A's Message
   (`messageId`, `contextId` = thread, `role`, `parts` with a plain-text fast path,
   `metadata`), so federation is nearly an identity mapping. Do *not* adopt A2A's
   transport (HTTP JSON-RPC, SSE, webhooks) or Task lifecycle locally: hosts can't be
   servers, and the daemon still needs inbox/cursors/cascade underneath. Multi-party
   threads and wake priority are modelbus additions A2A lacks. A2A's
   `input-required` state maps well onto needs-attention.

Model-facing: `to` / `thread`, `body`, `wake`, `wait`.

Internal: id, thread_id, from_agent_id, created_at, delivered_at per recipient,
delivery strategy used, expires_at for undelivered wakes, dedupe hash. Hop counter only
matters once relaying exists; not in v0.

### Conversation model

A conversation = participants + an append-only message log. DM key = the unordered
pair of agent ids; group key = group id with a member list. Adding a member to a group
is a membership change, not a new conversation. Internally messages still carry a
conversation id; the model just never needs it. Conversations are also the unit of
replication for P2P/cloud (section 12): two daemons sharing a DM replicate only that
DM; a group replicates among its members' daemons (Matrix-room style).

### Ergonomics check

Walk through as a Claude Code session: start → `sync()` says who you are and what is
waiting. Need the browser → `who("browser")` → `send(to: "aside-1", body, wait: 120)`
returns Aside's answer inline. Follow up → `send(to: "aside-1", body)`. Nothing else
to learn, and no ids to remember. OPEN whether this holds up for Aside's side, whose "turn" is a routine wake.

### Discovery is user-routed (LEANING)

In the current version, agents are not expected to go looking for other agents to
talk to. That is a statement about v0, not a rule: autonomous discovery may well be a
future feature, and nothing in the design should foreclose it. For now, an agent talks
to whoever the user pointed it at ("ask Aside to verify the deploy") or whoever
messaged it. So `who` is mostly a *resolver*: turn a reference
the user gave into an agent name. It filters on facts the daemon already has (host
kind, path, cwd, git repo, name, title), not on self-reported status. "The browser,"
"the Codex in this repo," "the Claude in ~/dev/foo" all resolve from free metadata.

A folder-scoped question ("does anyone under /dev handle billing?") that only the
user or an orchestrator sees is a possible later feature. It is not a broadcast and it
is not v0.

### The board (LEANING, probably not v0)

For "I'm working on X, tell me if you are too" without alerting anyone: a passive,
pull-only **board**. An agent may post a short note (e.g. "touching the auth module")
scoped to its folder; notes expire with the agent's presence or after a few hours.
Nobody is notified. Notes appear as an extra column in `who` output for agents in
scope, so reading costs nothing unless an agent calls `who`. No new tool. Posting is
explicit, optional, and rare; the instructions text does not tell agents to post or
check unless a "discovery" profile is enabled. The board is essentially the registry
with an optional note per agent. It must never trigger a message on its own.

### Contact policy: nothing happens without permission (LEANING)

Starting a **new thread** between two agents that the user did not introduce is a
policy decision, not a free action. Modes:
- `manual` (leaning default): a new thread initiated by an agent is *pending* until
  the user approves it in the UI (or an orchestrator does). Replies inside an approved
  thread never need approval. Threads the user creates by introducing agents are
  pre-approved.
- `open`: agents may start threads freely (for people who trust their setup, and for
  future autonomous discovery).
- orchestrator-mediated: the orchestrator approves instead of the user.

This keeps manual and orchestrator-driven setups from getting annoying, and gives
future autonomous discovery a permission model without new primitives.

## 5. Delivery cascade (LEANING)

Delivery is a chain of strategies per agent, tried in order, first success wins. Each
strategy is one file that registers itself. The daemon records which strategy actually
delivered, and a strategy that fails repeatedly for an agent is demoted.

1. **Native push:** Claude Code cross-session messaging socket, OpenCode HTTP API,
   Claude Agent SDK streaming input, OpenClaw `sessions_send`.
2. **Headless turn:** spawn or resume a turn: Goose run, Gemini non-interactive.
   (Aside has its own path, section 11.) **Codex now has a native queue path** and
   belongs in tier 1: `codex queue --thread <uuid|name> --message "..."` is an official
   subcommand (v0.153) that calls `thread/queue/add` on the local app-server daemon or
   an embedded one, which writes to the shared `~/.codex/queue_1.sqlite`; running TUIs
   watch a revision table and pick up items for their thread. The app-server API also
   documents `turn/start` and `turn/steer`. Live pid -> thread id comes from the
   rollout file or thread-writer lock the process holds open. (`~/.codex/ipc/ipc.sock`
   is unrelated: it fetches IDE context for the TUI's `/ide` command.)
3. **Terminal injection (last resort, inherently terminal-specific):** macOS gives a
   normal user no way to type into another process's tty (TIOCSTI returns EACCES;
   tested 2026-09-06), so every terminal that supports this does it through its own
   socket or scripting API. Supported set stays small: a pty that modelbus owns
   (`modelbus run <host>`, terminal-agnostic for launched sessions), cmux `send`
   (Joshua's terminal; socket CLI with `send`, `send-key`, `read-screen`,
   `focus-pane`), tmux send-keys, maybe iTerm2/Terminal.app AppleScript. Only after
   checking the foreground process is the agent, not a bare shell. Anything else is
   pull-only and the UI says so. Injected text must be wrapped so it cannot be
   mistaken for a direct user instruction (provenance, section 14).
4. **Hook piggyback:** for hosts with lifecycle hooks, the next hook drains the inbox.
5. **Pull only:** wait for the agent's next `sync`.

**Queue is the default; steer and inject are optional upgrades (Joshua, 2026-09-06).**
A message is queued for the recipient's next turn. A sender may ask for an upgrade to
*steer* (interrupt or adjust the active turn) or *inject* (terminal input), and the
upgrade happens only if the recipient's provider supports it. Most traffic is plain
queueing.

**Adapters are wake signals, not message carriers (from the Codex review, section 14).**
The message is stored once in the bus. What an adapter delivers is "you have mail"
(optionally carrying the body as a convenience, keyed by message id so a duplicate is
harmless). This makes falling through the cascade safe: two wake signals for one
message cannot make the agent act twice, because receipt is the agent's cursor
advancing past the message, not the adapter reporting success. Track four states
separately: stored, wake attempted (which adapter), receipt confirmed (cursor), reply
received. Never claim more than the state supports. Claude Code Channels explicitly
does not acknowledge processing, which is why this matters.

**Priority decides how far down the chain to go.** Normal priority stops at tier 5.
Wake priority tries 1 through 3. A normal-priority message may get a delayed push
(claude-peers-mcp uses 2 minutes) so recipients can drain cheaply.

Excluded under the hidden constraint: System Events keystrokes, notifications, anything
that opens or raises a window.

First adapters to build (LEANING, revised 2026-09-06 after inspecting the machine):
Codex `queue` and Claude Code's socket (both native, terminal-agnostic), then Aside
routines, then the pty launcher. cmux/tmux injection only as a fallback.

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

Messages store the id; everything agents read and write uses the name. The roster
carries facts the daemon gets for free: host kind, cwd, git repo/branch, last seen,
busy (mid-turn) or idle, and the host's own session title where one exists (Claude
Code and Aside both keep one). **Agents should not routinely report what they are
doing** (LEANING): self-reported status is noisy, stale, and costs tokens, and it only
matters when it concerns another agent, at which point it belongs in a message to that
agent. An optional `about` may be set once at launch (by the user or launcher) and
changed rarely. Keep names boring and stable.

**Registration is the first sync.** Agents register themselves (the alternative is
manual setup per session). If the agent arrives with a name (from the launcher env),
it keeps it. If it arrives without one, it gets one assigned at that moment. Names are
not pre-assigned by the daemon otherwise. Reclaim token stored by the launcher restores
identity and cursor after restart.

**Registration produces a placement request (LEANING).** A newly registered agent
shows up as *pending*: visible in the UI, not yet placed in the tree, and (OPEN)
either unable to message anyone or only able to message the user until placed. It may
propose a location (e.g. based on its cwd) after looking at the tree. If no
orchestrator is running, the user allows/denies and places it, e.g. by dragging it in
the UI. If an orchestrator is running, it handles this. Agents launched via
`modelbus run` are pre-approved because the user launched them, and `--at` places them
directly. Deny semantics are OPEN (block, or quarantine to user-only).

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

**Filesystem-like hierarchy (LEANING).** Terminology: the tree is a modelbus object
graph, **not the disk**. It has two node types: *folders* (containers) and *agents*.
A path like `/modelbus/backend/codex-1` is a modelbus address and has no relation to
any directory on the computer. Every agent has exactly one home path.

**Revised 2026-09-06: the hierarchy is out of the communication model entirely.**
Groups do everything folder-addressing was for (announcements = a muted group everyone
in a project is in). If a tree ever exists it is a UI grouping for the user's eyes
with zero effect on who receives what. The text below is kept for the record.

**The tree is optional and the default is flat (LEANING).** Every agent sits at the
root until the user makes a folder; if you never make one, you never see a tree. The
tree has nothing to do with communication (everything goes through threads); it is an
observation and scoping overlay. A **project** is a top-level folder with a scope flag:
agents inside see only each other by default, know their location relative to the
project, and do not interact outside it unless the policy allows. Cross-project
communication is possible in the architecture but expected to be rare. Global root, subdivided however Joshua organizes the
machine; the top level is *not* projects by default, since this is for everything on
the computer, not one project.
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
- Slack-style channels with @mentions can be **relegated**: a directory *is* the
  channel, scoped to your location in the tree. A message sent to a directory is an
  announcement visible to everything under it; `@name` inside it escalates to that
  agent. Because scope follows the tree, a channel log is only as noisy as your
  subtree. General channels remain suspect because reading logs is annoying; this is
  a later feature, not v0.

**Communication is expected to be mostly one-to-one.** The tree is an organizational
overlay (where things are, for the UI and for finding agents), not a routing structure.
Threads are the communication primitive; a pair thread is an edge in the graph view, a
three-plus thread is drawn as a small hub node with participants connected to it.
Multi-agent threads start as pairs and grow by **adding a participant to the thread**
(email CC / group DM semantics), not by creating groups. Thread membership is
ephemeral and dies with the conversation. One-to-many addressing is only for
announcements and may be left out of v0 entirely. A graph with non-overlapping groups
is the same structure as a shallow tree, so the two visualizations do not conflict.

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

## 10. The user as participant; orchestrator is optional (LEANING)

Joshua is a node on the bus. The web UI is that seat: read any thread, send messages,
introduce two agents by drawing an edge between them (which creates a thread and sends
both an introduction). This replaces manual context relaying, which is the whole point.

An LLM orchestrator is **not part of the core API and not assumed to exist.** If one is
ever wanted, it is an ordinary agent living high in the tree with the same tools as
everyone else. Per-project orchestrators were discussed and deferred indefinitely; an
agent that lives up the tree covers that if it is ever needed.

Because agents talk directly with no supervisor, the loop guards (section 6) and the
hidden constraint are what make unattended communication safe. They are not optional
in v0.

Join events go to a lobby address the user (and any orchestrator) can watch; other
agents are not pinged about joins. Pending placement requests (section 7) surface here.

**UI helpers for the user (LEANING, feasibility varies by host):**
- *Jump to the agent's window.* From the UI, focus the terminal pane or browser tab an
  agent lives in. For tmux this is `select-window`/`select-pane` plus activating the
  terminal app via AppleScript (iTerm2 and Terminal.app both support selecting a
  specific tab). For Aside, focus the session's bound tab. VS Code integrated terminals
  are probably out of reach. This is user-initiated focus, so it does not violate the
  hidden constraint.
- *Show when an agent needs the user.* Two sources: messages addressed to the user
  node at wake priority, and host-native "needs attention" signals the daemon can
  watch: Claude Code's Notification hook (permission prompts, idle), Aside's session
  `suspension` state (`ask-user-question`, visible in its SQLite and daemon logs), Codex
  approval prompts. Surface as a badge on the agent node and a list in the UI. Easy for
  Claude Code (hook) and Aside (readable state); OPEN for others.

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

## 12. Cloud, teammates, federation (FUTURE, discussed briefly)

Two possible futures: Joshua's own devices linked through a relay, and **teammates**
(other people's agents talking to Joshua's). The second changes more:

- **No central orchestrator**, obviously. Each person's daemon is sovereign.
- **No global id registry.** Ids should be self-certifying: a device id derived from a
  keypair fingerprint (SSH / Matrix / Nostr style), plus a local agent id. Two daemons
  can then pair by exchanging public keys or a pairing code with no registry.
  Consequence for v0: generate a daemon keypair at first run and derive the device id
  from it, even though nothing uses it yet. One-line decision now, migration later.
- **Trust boundaries.** Cross-daemon links are explicit and carry policy: which of my
  agents are exposed, whether remote agents may wake mine (default no), whether remote
  agents may read my logs (default no). "Visibility is wide" (section 9) becomes
  "visibility is wide *within one person's daemon*" and a policy knob across daemons.
  Messages from another person's agents are untrusted content and should be rendered
  with a clear source tag so models treat them as data, not instructions.
- **Delivery adapters stay local.** A remote daemon never touches my tmux panes; it
  hands the message to my daemon, which runs its own cascade.
- Remote agents can appear in the tree under a mount like `/remote/alice/...`, which
  fits the path model without special cases.

**Prior art for the teammate case (September 2026):**
- Claude Code cross-session messaging reaches the user's *own* other machines via
  Remote Control (v2.1.225+; Windows v2.1.239+). Same account only, Claude Code only,
  plain text, no persistence. Not cross-person, not cross-tool.
- A2A v1.0 (Linux Foundation, March 2026) is the standard for agent-to-agent over
  HTTP: signed agent cards, JSON-RPC, SSE streaming, HMAC-signed webhooks. Hermes
  Agent implements it peer to peer with per-peer bearer tokens, a 5-turn ping-pong
  cap, and a 60/min per-identity rate limit.
- ah-cli (annals-ai, TypeScript, MIT, 2 stars, last push May 2026) is a daemon-first
  local runtime that registers Claude/Codex agents and exposes them over A2A with a
  local web UI. It *runs* agents rather than connecting sessions you already have
  open; orchestration-shaped.
- Nobody found does "connect the sessions I already have running, across tools, and
  optionally to a teammate's." That gap is the premise.

**LEANING: internal protocol is modelbus (threads, three tools); the federation
boundary speaks A2A.** Do not invent a cross-machine wire protocol when a standard
with identity, auth, streaming, and push exists and makes Hermes-style peers reachable
for free. One adapter between the two protocols is cheaper than one protocol that must
be both tiny and complete.

Nothing here is built in v0 beyond the keypair-derived device id.

## 13. Code architecture sketch (LEANING)

```
core/       SQLite schema, agents, threads, messages, cursors, guards (constants in one file)
api/        MCP server (streamable HTTP) and the HTTP handlers the CLI and UI share
providers/  one module per host: detect(), configure(), deliver() strategies,
            attention() signals, focus(). e.g. providers/claude-code, providers/aside,
            providers/tmux (terminal injection is a provider too)
presence/   process-table and tmux scanner; merges with registered agents
cli/        modelbus serve | init | run | send | sync | who
ui/         web UI (graph + tree + threads + user seat)
```

The provider interface is the extensibility point: adding a host is one directory.
The delivery cascade (section 5) is just "ask each provider that claims this agent, in
priority order."

## 14. Review by a Codex session (2026-09-06)

Joshua ran a parallel Codex session (GPT-6, thread `01a0789c…`) over the same notes.
Its critique was good; the points worth carrying:

- **Delivery certainty.** Cascading adapters on "failed to report success" risks
  double delivery. Fix adopted in section 5: store once, adapters are wake signals,
  track stored / wake attempted / receipt / reply as separate states.
- **Session identity binding.** How does the daemon know *which conversation* called
  `sync()`? Two sessions in the same repo with the same MCP config, or a host sharing
  one MCP connection across conversations, could merge inboxes. A friendly name and a
  reclaim token do not solve this. LEANING: a per-session stdio shim spawned by the
  host, connected to the daemon over a unix socket, identified by walking the shim's
  parent process chain to the host pid and its registry entry. **Acceptance test:
  two sessions in one repository stay distinct.**
- **Loop guards do not stop unique-message ping-pong.** A asks, B answers and asks,
  forever, every message unique and under the rate limit. Add a **bounded number of
  automatic wakes per thread**, after which messages still store but do not wake, and
  the UI shows the pause. Also: `send(wait)` keeps the sender's turn active while the
  busy-guard holds delivery during active turns; the awaited reply must return through
  the pending tool call, not through a wake.
- **Do not double-gate.** Requiring approval for placement *and* for new threads
  recreates the friction modelbus exists to remove. A user introduction is enough
  permission for that collaboration. Contact policy (section 4) should read that way.
- **Provenance.** A message from Aside must arrive visibly attributed to Aside;
  pasted terminal text especially can look like a user instruction. Introducing two
  agents must not let either grant permissions on Joshua's behalf.
- **Liveness vs. activity.** Keep "confirmed live / uncertain / ended" separate from
  "working / idle / needs attention / unknown"; record evidence source and last check;
  never let saved history look live; one process can own several threads (Codex
  sub-agents), so distinguish process from conversation.
- Its proposed acceptance list for the detector: start/exit updates roster within
  seconds; two sessions in one directory stay distinct; idle sessions remain; stale
  registry files don't show as live; rename preserves identity; multi-thread
  processes are represented honestly; discovery causes no focus change or agent turn.
- It would defer A2A alignment and device-key identity until a concrete federation
  need. Reasonable for v0 scope; the field-naming choice is still cheap either way.

## 15. Experiment log

### 2026-09-06: Claude Code <-> Codex round trip (both directions work)

- **Claude -> Codex** via `codex queue --thread <uuid> --message ...` from a Bash call
  in Claude Code session `modelbus-8f`. The row appeared in `~/.codex/queue_1.sqlite`
  and was consumed within seconds; the message rendered in the Codex TUI as a normal
  user turn (with the provenance label first), and a turn started on its own. No
  prompt, no focus change. Clean.
- **Codex -> Claude** via the Claude Code inbox socket (`/tmp/cc-socks/<pid>.sock`,
  one JSON line `{"type":"user","message":{"role":"user","content":"..."}}`). Two
  gates fired, both by design:
  1. Codex's sandbox blocked the Unix socket connect; Codex asked Joshua for a
     one-time escalation in its own TUI.
  2. Claude Code **held** the message with an approval dialog ("sender did not attest
     its permission mode, and this session bypasses permission prompts"). Joshua
     approved; the message was delivered with a system note that it came from another
     session and cannot grant permissions.
- Lesson for the Claude Code provider: unattended delivery without dialogs should use
  the **own-child path**: a small poller spawned by the session's SessionStart hook
  inherits `CLAUDE_CODE_MESSAGING_SOCKET` and `CLAUDE_CODE_MESSAGING_TOKEN`, pulls
  from the modelbus daemon for that agent, and posts to its own session's socket with
  the auth line. Verified own-child messages are delivered even in bypass mode. The
  alternative (`crossSessionInbound: accept`) is a blunt per-session setting.
- Lesson for the Codex provider: Codex-side sends need a modelbus CLI that Codex is
  allowed to run (approved prefix rule) or a saved escalation rule; raw socket
  connects from inside its sandbox will always prompt.
- Both hosts' inbound paths keep provenance visible and refuse to treat a peer message
  as user approval, which matches section 14's provenance requirement.

## 16. Open questions (collected)

- Filesystem hierarchy vs. buses (section 8), and whether threads resolve the log
  concern.
- Placement of new agents in the tree; whether agents can self-place or self-join.
- Default visibility scope.
- Whether `send` is its own tool or just `sync` with an outbox.
- Explicit connect/disconnect tools vs. presence expiry.
- Device id in agent ids from day one (leaning yes, keypair-derived; section 12).
- Whether `send(wait)` ask-and-wait is ergonomic for hosts whose turns are routine
  wakes (Aside).
- Pending-agent semantics: can a pending agent message anyone? What does deny do?
- Contact policy default (`manual` vs `open`) and how pending threads look in the UI.
- Whether the board is worth building at all, and when.
- A2A at the federation boundary: confirm, and decide how modelbus threads map onto
  A2A tasks/messages when the time comes.
- Which hosts can support "jump to window" and "needs attention" signals.
- Everything in section 11 marked untested.
- What v0 actually includes. Leaning: register/sync, direct messages with thread
  ids, `who`, one wake adapter (tmux paste), loop guards, and the Aside experiment,
  with the acceptance test being Aside <-> Claude Code in both directions with nothing
  on screen. Presence detector and web UI may follow immediately after. Possibly less.
