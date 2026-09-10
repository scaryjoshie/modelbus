# Recommendation for the modelbus TUI

Status: proposal, September 2026. Nothing here is decided. Each point is marked
**practice** (established, cited in the sibling docs) or **judgment** (this
author's call for this project).

## The library question

**Judgment: no TUI library. Write a small renderer in `src/tui/`.**

The TUI is a viewer over two RPC calls, `who` and `log`: a list, a detail
pane, a log view, a filter line and a help overlay. That is fixed regions, not
a layout problem, with no text editing beyond a filter box. The hand-written
route costs a cell grid with row diffing, a twenty-entry key parser, and
terminal setup and teardown, all in `techniques.md` and all testable without a
terminal. Bun supplies `Bun.stringWidth` and `Bun.color`, so the dependency
count stays at zero.

Against each library, given the constraints:

- **OpenTUI** is the only Bun-first option and is proven in opencode, but it
  brings a 6 MB native binary over FFI, a 14 MB core, a tree-sitter peer
  dependency, a 0.5.x API with hundreds of releases in a year, and mouse and
  Kitty keyboard on by default. Right if this grows an editor or many widgets.
- **Ink** requires React, which the constraints exclude short of an
  overwhelming case, and has open Bun-specific bugs.
- **pi-tui** is closest in spirit, but Bun is not a stated target, it ships a
  markdown renderer this project would not use, and its releases follow
  another product.
- **terminal-kit** and the **blessed** family are CommonJS, typed only through
  DefinitelyTyped, and single-maintainer or unmaintained.
- **clack** solves prompts, not screens.

Fallback: if the renderer grows past a few hundred lines of layout code or
needs mouse and widgets, switch to `@opentui/core` without React or Solid
bindings. Only the view functions would change; the architecture below is
shaped so that stays true.

## Architecture

**Practice: Model, Update, View with one render loop** (the Elm architecture,
as in Bubble Tea). State is one plain object: the last `who` and `log`
results, the selected agent key, scroll offsets, active view, filter text,
focused pane, last poll time and error, terminal size. `update(state, msg)`
returns a new state; messages are `key`, `resize`, `poll` with data,
`pollError`, `tick`. `view(state, size)` is pure and writes into a cell grid.
No view touches the terminal.

**Practice: one render loop, diffed and synchronized.** `update` sets a dirty
flag; one scheduler draws at most once per frame (30 per second), diffs the
grid against the last, and flushes changed rows inside `CSI ? 2026 h` and `l`.
Resize discards the old grid.

**Judgment: polling loop.** One async function on an interval calls `who` and
`log` through the existing `rpc` client, skips a tick if the last call is in
flight, and dispatches `poll` or `pollError`. Two seconds is k9s's default and
matches the current temporary view; make it an option with an exported default.
On error keep the last data and show the error in the status row. The "models
never poll" rule is about agents; `src/tui.ts` already records that a UI may poll.

**Practice: the TUI is a client.** It imports `src/client.ts` and nothing from
core, runtime or providers. Host names appear only as data returned by `who`.

## Folder layout under `src/tui/`

| File | Responsibility |
|---|---|
| `index.ts` | `runTui(options)`: wires terminal, poller, loop; the only file the CLI imports |
| `terminal.ts` | raw mode, alternate screen, cursor, resize, restore on exit and crash |
| `keys.ts` | bytes to `Key` events; the only escape-sequence parser |
| `screen.ts` | cell grid, diff against previous, flush with synchronized output |
| `style.ts` | color roles to SGR, depth detection, `NO_COLOR` |
| `text.ts` | pad, truncate, align by column width |
| `state.ts` | `State`, `Msg`, `update` |
| `bindings.ts` | key table with help text; feeds both dispatch and the help overlay |
| `poll.ts` | the RPC interval |
| `views/` | `agents.ts`, `detail.ts`, `log.ts`, `help.ts`, `status.ts`, each `(state, rect, grid)` |
| `*.test.ts` | parser, diff, update and views tested against a grid, no terminal needed |

`src/tui.ts` becomes `src/tui/index.ts`; the CLI keeps calling `runTui`.

## What to avoid

- **Practice:** no clear-and-redraw per frame; no `console.log` while the
  alternate screen is active; no exit path that skips terminal restore.
- **Practice:** no row-index selection across polls; select by agent key.
- **Judgment:** no mouse in the first version; no borders around panes; no
  leader key; no keybinding config file until someone asks.
- **Judgment:** no widget abstraction while the second consumer of a widget
  does not exist.
- **Practice:** no dependency added without a sentence here saying what it replaces.
