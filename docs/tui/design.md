# Interaction and visual design for the bus TUI

Status: research, September 2026. What the good ones do, then what to take.
Claims about a tool come from its own docs, linked inline.

## What the good ones do

**lazygit** ([keybindings](https://github.com/jesseduffield/lazygit/blob/master/docs/keybindings/Keybindings_en.md)):
side panels plus one main panel; `?` opens a menu of every binding that applies
right now; `/` searches the current view; `Esc` cancels; `q` quits; `+` cycles
screen modes (normal, half, fullscreen). Why it works: every action is one
context-dependent key, and the `?` menu is the documentation.

**k9s** ([README](https://github.com/derailed/k9s/blob/master/README.md),
[commands](https://k9scli.io/topics/commands/)): a header shows cluster, context
and current hotkeys; `/` filters the table by regex as you type, `/!` inverts;
`:` enters a command; `?` lists bindings; refresh defaults to 2 seconds. Skins
name colors by role: body, info, frame border and focus, crumbs, and status
colors for new, modify, add, error, highlight, kill, completed
([skins](https://k9scli.io/topics/skins/)). Why it works: live rows under a
cursor that stays put, and a filter one keystroke away.

**htop and btop** ([htop](https://github.com/htop-dev/htop),
[btop](https://github.com/aristocratos/btop)): htop keeps a one-row key bar at
the bottom, `F1` or `h` help, `/` search, `\` filter, `t` tree. btop adds
optional vim keys, truecolor with automatic fallback to 256 colors and a
16-color TTY mode, nine layout presets, and synchronized output "to reduce
flickering". Why they work: dense, stable layout updated in place a few times
a second without feeling busy.

**tig** ([manual](https://jonas.github.io/tig/doc/manual.html)): one view by
default; `Enter` on a commit splits the screen with the diff below; `Tab`
moves between halves; `j`/`k` move, `/` searches, `n`/`N` step; `q` closes the
current view. Each view has a title line with its name, current item and
position. Why it works: master-detail appears on demand and leaves with `q`.

**opencode** ([keybinds](https://opencode.ai/docs/keybinds/),
[TUI](https://opencode.ai/docs/tui/)): a leader key (`ctrl+x`) to avoid terminal
conflicts, `ctrl+p` command palette, slash commands, themes; built on OpenTUI.
Take: a leader key suits dozens of commands; a viewer with ten does not need one.

**Bubble Tea** ([README](https://github.com/charmbracelet/bubbletea/blob/main/README.md),
[bubbles](https://github.com/charmbracelet/bubbles/blob/master/README.md)): the
Elm architecture, where Model is state, Update takes a message and returns the
new model plus an optional command, and View renders the model
([Elm guide](https://guide.elm-lang.org/architecture/)). The `key` package
declares each binding with its help text and `help` draws the short or full
help from those declarations, so help never drifts from the bindings. `list`
filters as you type; `viewport` scrolls.

## Guidance for this TUI

**Keyboard-first and discoverable.** A bottom status row lists the five or six
keys that matter in the current pane, generated from the same binding table
that dispatches them. `?` overlays the full table. `Esc` always backs out one
level (close overlay, clear filter, leave detail); `q` quits from the top only.

**Master-detail.** Left: the agent list, one row per agent, sorted by host then
name: name, host, reachability, status, age of last-seen. Right, or below on
narrow terminals: the selected agent's detail and its conversations. `Enter`
opens, `Esc` closes, `Tab` moves focus. A second top-level view is the message
log with delivery state; `1` and `2` switch views. With 40 agents on three
hosts the list is the point, so it gets the width.

**Filter as you type.** `/` opens a one-line filter at the bottom; each
keystroke narrows the list on name, host, directory and status; `Enter` keeps
the filter and returns focus; `Esc` clears it. The count reads "12 of 43"
while a filter is on.

**Live data without losing the user.** Poll on a fixed interval. On new data,
keep the selection by agent key, not row index, and keep the scroll offset
unless the selection would leave the screen. Never re-sort under the cursor
while the filter box has focus. Show the time of the last successful poll in
the status row.

**Color roles, one meaning each.** Reachable and delivered share one color;
unreachable and failed another; sent-but-waiting a third; selection is an
inverse or bold row, never a color. Everything else is default foreground. Dim
secondary fields such as age and directory. Bold marks the focused pane title only.

**Empty and error states.** No agents: one line saying so and the command that
registers one. No messages for an agent: one line. Daemon unreachable: keep the
last data on screen, put the error and socket path in the status row, keep
retrying. The screen never goes blank and the app never exits on its own.

**Restraint.** No borders around every pane; a title line and whitespace
separate regions. No gradients, logos, or spinners on a static list. Truncate
with an ellipsis, never wrap cells. Right-align ages and counts. The frame
should look like well-formatted `ps` output that happens to move.
