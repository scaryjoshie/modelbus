# Techniques every full-screen TUI needs

Status: research, September 2026. `CSI` means `ESC [`; sequences are from
[xterm control sequences](https://invisible-island.net/xterm/ctlseqs/ctlseqs.html)
unless linked otherwise.

## Alternate screen

`CSI ? 1049 h` saves the cursor and switches to a cleared alternate buffer;
`CSI ? 1049 l` restores, leaving scrollback untouched. Hide the cursor with
`CSI ? 25 l` while drawing; show it on exit.

## Raw mode and restoring the terminal

When `process.stdin.isTTY`, call `setRawMode(true)` and read `data` events
([Node tty](https://nodejs.org/api/tty.html)). Bun implemented `setRawMode` in
2023 ([bun #2025](https://github.com/oven-sh/bun/issues/2025)), fixed a Windows
difference in May 2026 ([bun #9853](https://github.com/oven-sh/bun/issues/9853)),
and lists `node:tty` and `node:readline` as fully implemented
([bun docs](https://bun.com/docs/runtime/nodejs-apis)).

Write one idempotent restore function: raw mode off, cursor shown, mouse and
paste modes off, main screen. Call it from `process.on("exit")`, from `SIGINT`,
`SIGTERM` and `SIGHUP` handlers that then exit, and from `uncaughtException`
after printing the error ([Node process](https://nodejs.org/api/process.html)).
In raw mode Ctrl+C is byte 3, not a signal, so the key handler must exit too.
[signal-exit](https://github.com/tapjs/signal-exit) packages this pattern.
Nothing catches SIGKILL.

## Resize

`process.stdout` emits `resize` and updates `columns` and `rows`
([Node tty](https://nodejs.org/api/tty.html)); Bun added the Windows case in
1.3.3 ([release notes](https://bun.com/blog/bun-v1.3.3)). Debounce (OpenTUI
waits 100 ms) and redraw from the new size.

## Avoiding flicker

Never clear the screen per frame. Keep a grid of cells (character plus style),
render the next frame into a second grid, and write only rows that differ,
positioning with `CSI row ; col H`. Wrap each flush in `CSI ? 2026 h` and
`CSI ? 2026 l` so the frame appears atomically
([spec](https://gist.github.com/christianparpart/d8a62cc1ab659194337d73e399004036)).
Terminals without it ignore the sequence, so sending blind is safe; btop and
pi-tui do. Set a dirty flag and draw at most once per frame; Ink, OpenTUI and
Bubble Tea all default to 30 per second.

## Keyboard

In raw mode a key is a byte sequence: UTF-8 for printable characters, bytes 1
to 26 for Ctrl+letter, 13 Enter, 127 Backspace, 27 Escape, `ESC [ A` to `D` for
arrows, `ESC [ H` and `F` for Home and End, `ESC [ 5 ~` and `6 ~` for Page Up
and Down, `ESC` then the key for Alt. A lone `ESC` is ambiguous with a sequence
start; treat `ESC` with nothing after it in the same read as Escape. Node's
`readline.emitKeypressEvents` decodes these
([Node readline](https://nodejs.org/api/readline.html)); a hand-written parser
for these twenty sequences is about as long and easier to test. Vim keys are
plain characters in the same table; chords like `g g` need a pending key and a
timeout.

The [Kitty keyboard protocol](https://sw.kovidgoyal.net/kitty/keyboard-protocol/)
removes the ambiguities (`CSI > 1 u` to enable, `CSI < u` to pop) in kitty,
ghostty, WezTerm, iTerm2, foot, Alacritty and Windows Terminal; an optional
refinement. Bracketed paste (`CSI ? 2004 h`) wraps pasted text in `ESC [ 200 ~`
and `ESC [ 201 ~` so a paste into the filter box is not read as keys.

## Focus and panes

Focus is one field of state; keys go to the focused pane first, then to global
bindings. Panes are rectangles computed from the terminal size each frame; two
or three fixed regions need no layout engine.

## Long lists

Render only the visible window: keep `cursor` and `offset`, clamp so the cursor
stays visible, draw `rows` items from `offset`. Sort and filter once per data
change, not per frame.

## Colors and detection

Three tiers: 16 (`CSI 3x m`), 256 (`CSI 38 ; 5 ; n m`), truecolor
(`CSI 38 ; 2 ; r ; g ; b m`). Decide as
[supports-color](https://github.com/chalk/supports-color) does: `FORCE_COLOR`
wins; `NO_COLOR` set and non-empty disables color
([no-color.org](https://no-color.org/)); `TERM=dumb` or no TTY disables;
`COLORTERM=truecolor` or `24bit` means truecolor; `TERM` ending `-256color`
means 256; else 16. `Bun.color(x, "ansi")` reads the depth from the environment
too ([Bun color](https://bun.com/docs/runtime/color)). With `TERM=dumb` or no
TTY, skip the full-screen view and print the plain table instead.

## Unicode width

Width is not length: East Asian wide characters take two cells
([UAX #11](https://www.unicode.org/reports/tr11/)), emoji sequences vary
([UTS #51](https://www.unicode.org/reports/tr51/)), combining marks take zero.
`Bun.stringWidth` handles ANSI codes, emoji and wide characters
([Bun utils](https://bun.com/docs/api/utils)); the portable equivalent is
[string-width](https://www.npmjs.com/package/string-width). Truncate by
accumulated width, not by slice.

## Mouse

`CSI ? 1002 h` reports clicks and drags; `CSI ? 1006 h` selects the SGR
encoding. While on, native text selection stops working. For a keyboard-first
tool leave it off; wheel scrolling is the one thing worth adding later.

## Polling without blocking input

Input arrives as `stdin` events; the RPC poll is an async function on an
interval. They share the event loop and never block each other as long as the
render path has no `await`. Skip a tick if the previous call is still in flight,
keep the last good result on error, and compare new data with old so an
unchanged poll does not redraw.
