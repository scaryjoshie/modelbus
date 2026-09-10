# TUI plan

Status: as built for the skeleton, September 2026. `decision.md` stands: no
library, state/update/view, one diffed render loop, one poller, read-only.

## Views

Master-detail: list pane left (or above, under 110 columns), detail pane, one
status row.

- **agents** (`1`): one row per agent: name, host, reachability, status, age of
  last seen. Reachable is `ok`, unreachable `bad`.
- **log** (`2`): one row per delivery: age, from, to, status, first body line.
  `delivered` and `read` are `ok`, `failed` `bad`, `sent` `wait`.
- **detail**: agents view, the selected agent's fields then its messages oldest
  first; log view, the selected message's header and full body. Scrolls when focused.
- **status**: key hints, "12 of 43" under a filter, time of the last good poll,
  the last error with the socket path; the filter prompt while the box has focus.
- **help** (`?`): every binding with label and help text, over the body.
- **empty**: no agents, one line plus the registering command; no messages, one
  line. Daemon down: last data stays, error in status.

## Keys

| Key | Action | When |
|---|---|---|
| `q` | quit | list focused, no overlay |
| `q` | back | help open or detail focused |
| `ctrl+c` | quit | always, filter box included |
| `esc` | back: close help, else leave detail, else clear filter | always |
| `?` | toggle help | always |
| `1` / `2` | agents view / log view | no overlay |
| `j` `↓` / `k` `↑` | move down / up (scroll when detail focused) | no overlay |
| `pgdn` `ctrl+d` / `pgup` `ctrl+u` | page | no overlay |
| `g` `home` / `G` `end` | first / last row | no overlay |
| `enter` | focus detail | list focused |
| `tab` | list ⇄ detail | no overlay |
| `/` | focus the filter box | no overlay |
| filter: text | appends and narrows at once | |
| filter: `backspace`, `ctrl+u` | delete one, delete all | |
| filter: `enter` / `esc` | keep / clear the filter; focus returns to the list | |

`BINDINGS` in `bindings.ts` is the table; `hints(state)` feeds the status row,
`active(state)` the help overlay, `lookup` the dispatcher.

## Types (`state.ts`)

```ts
type Agent = Result<"who">["agents"][number];   // RosterEntry
type Message = Result<"log">["rows"][number];   // LogRow
type View = "agents" | "log";
type Focus = "list" | "detail" | "filter";

interface State {
  view: View; focus: Focus; help: boolean; filter: string;
  agents: Agent[]; messages: Message[];
  selectedAgentId: string | undefined; selectedSeq: number | undefined;
  scroll: { agents: number; log: number; detail: number };
  lastPollAt: number | undefined; error: string | undefined;
  size: { cols: number; rows: number }; now: number; quit: boolean;
}

type Msg =
  | { type: "key"; key: Key }
  | { type: "resize"; size: Size }
  | { type: "poll"; agents: Agent[]; messages: Message[]; at: number }
  | { type: "pollError"; error: string; at: number }
  | { type: "tick"; now: number };

function update(state: State, msg: Msg): State;   // pure
```

## View signature

```ts
export function drawX(state: State, rect: Rect, grid: Grid): void;
```

Pure: draw into the grid, touch nothing else. Use `grid.put`, `grid.fill`, the
width helpers in `text.ts`, and the style roles in `style.ts` (`ok`, `bad`,
`wait`, `selected`, `title`, `dim`, `plain`). The focused pane's title is
`title`; the cursor row is `fill` with `selected` then `put`. Row 0 of a pane is
its title; items start at `rect.y + TITLE_ROWS`, `bodyRows(rect)` of them from
`state.scroll`. `update` uses the same numbers to keep the cursor on screen.

## Behavior on new data

- **Filter**: case-insensitive substring on name, host, cwd, status, title
  (agents) or from, to, status, body (log), on every keystroke. One string for
  both views.
- **Sort** is fixed: host then name; messages by sequence. New data cannot
  reorder existing rows, so nothing moves under the cursor.
- **Selection** by agent id or message seq. A vanished row yields to the row now
  at its index; an empty list to nothing. The first poll selects the first
  agent. The log selects the newest message and follows new ones while the
  cursor is on the last row.
- **Scroll** offsets hold unless the selection would leave the window, then move
  the least that shows it. Detail scroll resets when the selection changes.
  Resize re-clamps and forces a full redraw.
- **Errors** keep the last data; the next success clears `error`.

## Files

```
src/tui/
  index.ts      runTui: terminal, poller, clock, frame scheduler
  terminal.ts   raw mode, alternate screen, resize, idempotent restore
  keys.ts       bytes -> Key; escape-sequence tables; keyId
  screen.ts     Grid, Rect, Cell; render(prev, next, depth): row diff, sync output
  style.ts      Style roles, detectDepth (NO_COLOR, FORCE_COLOR, TERM), sgr
  text.ts       width, truncate, fit, fitRight, age, shortenHome, firstLine, clock
  layout.ts     Size, Layout, layout(size), bodyRows, TITLE_ROWS
  state.ts      State, Msg, update, initialState
  bindings.ts   BINDINGS, active, hints, lookup, label
  filter.ts     visibleAgents, visibleMessages, agentMessages, selectedAgent, selectedMessage
  view.ts       one frame: layout plus every view into a Grid
  poll.ts       startPoller({ intervalMs, dispatch, request }), DEFAULT_POLL_INTERVAL_MS
  views/        agents.ts detail.ts log.ts status.ts help.ts empty.ts
  *.test.ts     keys, screen, state
```

`modelbus tui` is the verb; `src/tui.ts` is gone.

## Ownership for the builders

Message `tui-designer` with the exact change when a shared file needs one; never
edit another owner's file.

- **Builder A**: `views/agents.ts`, `filter.ts` (the stub is the contract: keep
  its signatures). Tests against a `Grid`.
- **Builder B**: `views/detail.ts`, `views/log.ts`. Tests against a `Grid`.
- **Builder C**: `views/status.ts`, `views/help.ts`, `views/empty.ts` (A and B
  call `drawEmpty`), and hardening `terminal.ts`: restore on every exit path,
  signals, uncaught errors printed after restore, resize debounced 100 ms, no
  writes after restore.
- **Designer**: `state.ts`, `bindings.ts`, `index.ts`, `screen.ts`, `keys.ts`,
  `style.ts`, `text.ts`, `poll.ts`, `layout.ts`, `view.ts`.

## Proposed, not decided

- **Send from the TUI.** Needs the author's decision on who the person is on the
  bus: a registered agent with a token, or a new identity kind.
- Bracketed paste for the filter box; a refresh key; mouse wheel scrolling.
