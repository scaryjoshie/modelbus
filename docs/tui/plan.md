# TUI plan, version two

Status: designed September 2026 on top of the version-one renderer. `decision.md`
stands: no library, state/update/view, one diffed render loop, one poller.
Version one's controls (a generic viewer: `1`/`2`, `j`/`k`, focusable detail
pane, `/` filter) were rejected by the author. The controls below are the
author's and are not open for redesign.

## Screen

Row 0 is the tab bar: `Agents 41  Chats 3`, each name followed by its count
in `dim`, the active tab's name in `title` style. While a filter narrows the
active tab its count reads `12/41`. Below it the body, split into a list pane
and a detail pane (side by side from 110 columns, list above detail below
that), then one status row at the bottom.

- **Agents tab.** List: one row per agent (name, host, reachability, status,
  age of last seen), a mark on pending agents. Detail: the selected agent's
  fields and its messages from the log, oldest first. The detail pane always
  follows the selection; it has no focus and no cursor.
- **Chats tab.** List: one row per conversation from `conversations`: kind
  (`#name` for a group, `dm` for a pair), members, unread count, last message.
  Detail: the selected conversation's messages, always: a title naming it and
  its members, then the messages from `history` newest last, each with sender,
  time and the body wrapped to the pane, in the same look as the Agents
  detail pane. Selecting a row in the list is what shows a chat; nothing
  opens. `Enter` only decides which pane the arrows move: the list, or the
  messages pane so it scrolls. The focused pane's title is bold. Nothing on
  this tab changes the screen's shape.
- **Status row.** Key hints for the active tab, `N pending` while agents are
  marked, the time of the last good poll, the last error or the last action's
  failure in `bad`. Counts live in the tab row, not here. While a prompt is up
  the row is the prompt instead.
- **Help overlay** (`?`): every binding that applies, over the body.
- **Empty states.** No agents: one line and the registering command. No chats:
  one line. Daemon down: the last data stays, the error goes to the status row.

Nothing is typed into a chat in this version: the author's identity on the bus
is not decided. The only writes are `group` and `rename`, both behind a prompt.

## Keys

| Key | Agents tab | Chats tab |
|---|---|---|
| `Tab` | switch tab | switch tab |
| `↑` `↓` | move the selection | move the selection; with the messages pane focused, scroll it |
| `f` | filter as you type | filter as you type |
| `c` | mark or unmark the selected agent as pending | |
| `Enter` | two pending: create their DM and select it. Three or more: prompt for a group name, create the group, select it | give the arrows to the messages pane |
| `r` | rename the selected agent: prompt, then `rename` | |
| `Esc` | close help, else clear pending, else clear the filter | close help, else give the arrows back to the list, else clear the filter |
| `?` | help overlay | help overlay |
| `q` | quit | quit |
| `ctrl+c` | quit, prompts included | quit, prompts included |

Inside a prompt every other key is text: `q` is a character, `Backspace`
deletes one, `ctrl+u` deletes all, `Enter` confirms, `Esc` cancels.

Not in the table, so not bound: `1`/`2`, `j`/`k`, page and home/end keys. The
hints show the table's keys only. There is no mode: `Enter` and `Esc` on the
Chats tab change which pane the arrows move and the bold title, nothing else.

`BINDINGS` in `bindings.ts` is the table: `lookup` dispatches from it, `hints`
feeds the status row, `active` feeds the help overlay, `label` spells keys.

## Prompts

One mechanism serves the filter, the group name and the rename: `state.prompt`
is a small union, and while it is set the keyboard belongs to it.

```ts
type Prompt =
  | { kind: "filter"; text: string }
  | { kind: "group"; text: string; members: string[] }   // agent names, in pending order
  | { kind: "rename"; text: string; agent: string };      // the agent's current name
```

- `f` opens `filter` with the current filter text; every edit is copied to
  `state.filter` at once, so the list narrows as you type. `Enter` keeps the
  filter and closes the prompt; `Esc` clears it and closes the prompt.
- `Enter` on the Agents tab with three or more pending opens `group` with the
  pending agents' names. `Enter` with a non-empty name confirms: the prompt
  closes, the pending set clears, and the `createGroup` effect runs. `Esc`
  cancels and keeps the pending set.
- `r` opens `rename` for the selected agent with empty text. `Enter` with a
  non-empty name confirms and runs the `rename` effect. `Esc` cancels.

`views/prompt.ts` draws the prompt over the status row: a label (`filter`,
`group name`, `rename <agent>`), the text, a caret. `promptLabel(prompt)` in
`state.ts` gives the label so the view and the tests agree on it.

## Effects

`update` stays pure. It returns a `Step`: the next state and, sometimes, one
`Effect` describing a daemon call it wants made. `index.ts` runs the effect
through `actions.ts` and dispatches whatever message comes back.

```ts
type Effect =
  | { type: "openDm"; a: string; b: string }                  // agent names
  | { type: "createGroup"; name: string; members: string[] }  // agent names
  | { type: "rename"; agent: string; name: string }           // current name, new name
  | { type: "loadHistory"; id: string; spec: string };        // the selected conversation's page

interface Step { state: State; effect?: Effect }
function update(state: State, msg: Msg): Step;

// actions.ts
function runEffect(effect: Effect, request = rpc): Promise<Msg | undefined>;
```

`runEffect` never throws: a failure becomes `{ type: "actionFailed", error }`,
which the status row shows in `bad` until the next key.

- `openDm`: the daemon creates a DM on first use of `a,b`, so `history` for
  `a,b` both creates it and returns its messages. `conversations` is then asked
  once to learn the new conversation's id (an empty DM has no message to carry
  it). Resolves to `conversationCreated`.
- `createGroup`: `group { name, add: members }`, then `history` for `#name`
  and `conversations`. Resolves to `conversationCreated`.
- `rename`: `rename { agent, name }`. Resolves to nothing on success; the next
  poll shows the new name and the selection, by id, stays put.
- `loadHistory`: `history` for the spec. Resolves to `history`. Issued by any
  key that puts a different conversation on screen (moving the list, switching
  to the tab), so its page does not wait for the next poll.

## State and messages (`state.ts`)

```ts
type Agent = Result<"who">["agents"][number];                         // RosterEntry
type Message = Result<"log">["rows"][number];                         // LogRow
type Conversation = Result<"conversations">["conversations"][number]; // ConversationOverview
type ChatMessage = Result<"history">["items"][number];                // InboxItem
type Tab = "agents" | "chats";
/** Chats tab: which pane the arrows move. */
type Focus = "list" | "messages";

/** The newest page of one conversation, oldest first. Stale once another is selected. */
interface History { id: string; messages: ChatMessage[] }

interface State {
  tab: Tab;
  focus: Focus;
  help: boolean;
  /** Narrows the active tab's list; the filter prompt edits it live. */
  filter: string;
  prompt: Prompt | undefined;
  agents: Agent[];
  messages: Message[];              // the log; the agent detail pane reads it
  conversations: Conversation[];
  /** Agents marked with `c`, by id, in the order they were marked. */
  pending: readonly string[];
  selectedAgentId: string | undefined;
  selectedConversationId: string | undefined;
  /** Messages of the selected conversation, once `history` has answered for it. */
  history: History | undefined;
  /** First visible row of each list; first visible line of the messages pane. */
  scroll: { agents: number; chats: number; messages: number };
  lastPollAt: number | undefined;
  /** The last poll's failure; cleared by the next success. */
  error: string | undefined;
  /** The last action's failure; cleared by the next key. */
  notice: string | undefined;
  size: Size;
  now: number;
  quit: boolean;
}

type Msg =
  | { type: "key"; key: Key }
  | { type: "resize"; size: Size }
  | { type: "poll"; agents: Agent[]; messages: Message[]; conversations: Conversation[]; at: number }
  | { type: "pollError"; error: string; at: number }
  | { type: "history"; id: string; messages: ChatMessage[]; at: number }
  | { type: "conversationCreated"; id: string; conversations: Conversation[]; messages: ChatMessage[] }
  | { type: "actionFailed"; error: string }
  | { type: "tick"; now: number };
```

A `history` whose id is not the selected conversation's is dropped: the
selection moved while it was in flight; the next tick asks again. The view
tells a stale page from a fresh one by `history.id`, and shows "loading" until
they match. `conversationCreated` switches to the Chats tab, clears the pending
set and the filter, selects the new row and stores its page.

`conversationSpec(c)` in `filter.ts` turns a `Conversation` into the string
`history` wants; `conversationLabel(c)` gives the list its `#name` or `dm`.

## Behavior on new data

- **Filter** is one string, applied to the active tab: agents on name, host,
  cwd, status, title; conversations on the label, the members' names and the
  last message's body. Case-insensitive substring, on every keystroke.
- **Sort** is fixed. Agents by host then name. Conversations by the daemon's
  order (newest activity first) as given; the poller passes the array through.
  Chat messages by sequence.
- **Selection** by id. A vanished row yields to the row now at its index; an
  empty list to nothing. The first poll selects the first row of each list.
- **Pending** survives polls; ids no longer on the roster are dropped.
- **Scroll** offsets of the lists hold unless the selection would leave the
  window. The messages pane's offset is a line index into `chatLines`: it
  follows the newest message while the pane shows the tail (the offset is at
  its maximum), stays put otherwise, and goes to the tail when the selection
  changes or a page lands for a new selection. Resize re-clamps and forces a
  full redraw.
- **Errors** keep the last data; the next success clears `error`.

## View signatures

```ts
export function drawTabs(state: State, rect: Rect, grid: Grid): void;    // views/tabs.ts
export function drawAgents(state: State, rect: Rect, grid: Grid): void;  // views/agents.ts
export function drawChats(state: State, rect: Rect, grid: Grid): void;   // views/chats.ts
export function drawChat(state: State, rect: Rect, grid: Grid): void;    // views/chat.ts
export function chatLines(state: State, w: number): Line[];             // views/chat.ts
export function drawDetail(state: State, rect: Rect, grid: Grid): void;  // views/detail.ts
export function drawStatus(state: State, rect: Rect, grid: Grid): void;  // views/status.ts
export function drawPrompt(state: State, rect: Rect, grid: Grid): void;  // views/prompt.ts
export function drawHelp(state: State, rect: Rect, grid: Grid): void;    // views/help.ts
export function drawEmpty(rect: Rect, grid: Grid, message: string, hint?: string): void;
```

Pure: draw into the grid, touch nothing else. Use `grid.put`, `grid.fill`, the
width helpers in `text.ts`, and the style roles in `style.ts` (next section).
Row 0 of a pane is its title;
items start at `rect.y + TITLE_ROWS`, `bodyRows(rect)` of them from the pane's
scroll offset. The cursor row is `fill` with `selected` then `put`. On the
Agents tab no pane title is bold. On the Chats tab the pane that has the
arrows (`state.focus`) has its title bold. `title` also marks the active tab.

`view.ts` composes a frame: tabs; the list rect gets `drawAgents` or
`drawChats`, the detail rect `drawDetail` or `drawChat`, by tab; then
`drawPrompt` or `drawStatus` in the status rect; then `drawHelp` over the body
when help is up. Both tabs have the same shape, always.

**The messages pane.** `chatLines(state, w)` is every line the pane would show
below its title at width `w`, for the selected conversation: one dim
"loading" line while `history` is missing or names another conversation; one
dim "no messages" line for an empty page; else, per message, a header line
(sender in its host's hue, time dim) and the body wrapped to the pane and
indented, a blank line between messages. `drawChat` draws
`chatLines` from `state.scroll.messages`, `bodyRows(rect)` of them, under a
title naming the conversation (kind color) and its members (host hues).
`update` asks `chatLines` for the line count to clamp the offset, the way it
asked `detailLines` in version one, so the pane and the clamp agree.

## Color roles (`style.ts`)

One meaning per color, and the same meaning in every view. `Style` names the
roles; only `style.ts` knows what they look like at a depth. Under `NO_COLOR`
or a dumb terminal every role is plain text; with 16 colors the roles take the
standard colors and the hosts the bright ones; with 256 the roles are muted
and the hosts vivid, all of middling brightness so they read on dark and
light backgrounds. Names are colored by host, so the color says where an
agent runs: the author found per-agent colors meant nothing to a reader.

| Role | Where |
|---|---|
| `group` | a group's `#name`: Chats list kind column, chat header, detail pane |
| `dm` | the `dm` label of a pair, in the same places |
| `hostStyle(roster, host)` | an agent's name and its host tag, everywhere a name appears: Agents list, detail fields, chat members, message senders, the last-message sender in the Chats list. One hue per host: the roster's distinct hosts, sorted, take the hues in order, so up to six hosts are all distinct and no host is named in the TUI (only providers name hosts). A host absent from the roster takes the hue after the last. The host tag on the roster is in the same hue as the name, never a different color, so the tag is the legend |
| `accent` | the pending mark in an agent's row and the `N pending` count; a non-zero unread count |
| `dim` | ages, times, the clock, inactive tabs and every tab count, zero unread counts, field labels, hint text, the prompt label |
| `title` | the active tab only; no pane title is bold |
| `ok` `wait` `bad` | delivery states (delivered or read, sent, failed); reachability (`ok` up, `bad` down); the status row's error and notice in `bad` |
| `selected` | the cursor row, inverse, every cell of it: colors never fight the inverse |
| `plain` | everything else: bodies, status words, hint keys, prompt text |

Where a view has a host, use `hostStyle(host)`: roster rows and the agent
detail have `agent.host`; chat messages have `fromHost`. Where it has only an
id (a conversation's `participants[i].id`, the log's `fromAgentId`), use
`hostStyleById(state.agents, id)`, which is the host's hue when the agent is
on the roster and `plain` when it is not. Never color by name or by id hash.

## Polling (`poll.ts`)

One tick every 2 seconds: `who`, `log` and `conversations` together, then one
`poll` message. When a conversation is selected, `history` for its spec in the
same tick, then one `history` message. A tick is skipped while the previous
one is in flight. A failed tick becomes `pollError` and the last data stays.
The poller asks `selected()` for the conversation's id and spec at the start
of each tick, on either tab, so the page is fresh when the tab is shown.

Models never poll; this UI does, the way `who` on a timer would.

## Files

```
src/tui/
  index.ts       runTui: terminal, poller, clock, frame scheduler, effect runner
  actions.ts     runEffect: the daemon calls behind Enter and the prompts
  terminal.ts    raw mode, alternate screen, resize, idempotent restore
  keys.ts        bytes -> Key; escape-sequence tables; keyId
  screen.ts      Grid, Rect, Cell; render(prev, next, depth)
  style.ts       Style roles, hostStyle, hostStyleById, detectDepth, sgr
  text.ts        width, truncate, fit, fitRight, age, shortenHome, firstLine, clock
  layout.ts      Size, Layout, layout(size), bodyRows, TITLE_ROWS, TAB_ROWS
  state.ts       State, Msg, Effect, Step, Prompt, Chat, update, initialState, promptLabel
  bindings.ts    BINDINGS, active, hints, lookup, label
  filter.ts      visibleAgents, visibleConversations, agentMessages, selectedAgent,
                 selectedConversation, conversationSpec, conversationLabel
  view.ts        one frame
  poll.ts        startPoller({ intervalMs, dispatch, request, selected })
  views/         tabs.ts agents.ts chats.ts chat.ts detail.ts status.ts prompt.ts help.ts empty.ts
  *.test.ts      keys, screen, style, terminal, state, filter, and one per view
```

## Ownership for the builders

Message `tui-designer-2` with the exact change when a shared file needs one;
never edit another owner's file. Every view has a stub or a version-one body
in place; keep the exported signatures.

- **Builder A**: the Agents tab. `views/agents.ts` (add the pending mark: an
  `accent` glyph in the first column of a marked row; name and host tag both
  in `hostStyle(agent.host)`; keep the title plain since no pane has focus) and `filter.ts` (the stub is the contract; implement
  `visibleConversations`, `selectedConversation`, `conversationSpec`,
  `conversationLabel` if they are still stubs). Tests against a `Grid`.
- **Builder B**: the Chats tab. `views/chats.ts` (the list; title bold while
  `focus` is `list`), `views/chat.ts` (the messages pane: `chatLines` and
  `drawChat` as above; title bold while `focus` is `messages`), and
  `views/detail.ts` (Agents tab only, unfocused: plain title, follows the
  selection). Kinds in `group`/`dm`, names in the host's hue (`hostStyle`
  where a host is at hand, `hostStyleById` from an id), unread in `accent`
  or `dim`.
  Tests against a `Grid`.
- **Builder C**: `views/tabs.ts` (names with their counts as above; active
  name `title`, inactive `dim`, counts `dim`), `views/status.ts` (hints,
  pending count in `accent`, clock, error then notice in `bad`; no counts), `views/prompt.ts`,
  `views/help.ts`, `views/empty.ts`, and `terminal.ts`.
- **Designer** (`tui-designer-2`): `state.ts`, `bindings.ts`, `actions.ts`,
  `index.ts`, `screen.ts`, `keys.ts`, `style.ts`, `text.ts`, `layout.ts`,
  `view.ts`, `poll.ts`.

## Proposed, not decided

- **Send from the TUI.** Needs the author's decision on who the person is on
  the bus.
- **Older history.** `history` pages with `before`; the TUI fetches only the
  newest page (the daemon's pull limit). A key to load older messages is easy
  once wanted.
- Page and home/end keys; bracketed paste for prompts; mouse wheel scrolling.
