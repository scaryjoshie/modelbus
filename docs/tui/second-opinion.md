# TUI approach: a second opinion from running the candidates

Written September 10, 2026 as an independent check on the library survey. Everything
under "Verified by running" was measured on macOS (arm64) with Bun 1.4.0 in a
pseudo-terminal driven by `expect`. Everything under "Read, not run" comes from
package metadata and public source and was not executed here.

## What was built

The same small app four times: a 40-item list on the left, a bordered detail pane on
the right, a status bar, arrow keys, `q` to quit, and a timer that rewrites the detail
text every second. The harness starts each app at 24x80, waits three ticks, sends four
arrow keys, resizes to 30x100, and quits. Output bytes were captured and replayed
through a terminal emulator to check the screen. Startup is spawn to first frame.

## Verified by running

| | [OpenTUI core](https://www.npmjs.com/package/@opentui/core) 0.5.11 | [Ink](https://www.npmjs.com/package/ink) 7.1.1 + React 19.3.0 | [neo-blessed](https://www.npmjs.com/package/neo-blessed) 0.2.0 | No library |
|---|---|---|---|---|
| Runs on Bun | yes | yes | yes | yes |
| Packages installed | 12 | 38 | 1 | 0 |
| `node_modules` size | 49 MB (23 MB is TypeScript, pulled in as a peer dependency) | 23 MB | 1.7 MB | 0 |
| Startup, 5 runs | 71 to 83 ms | 104 to 154 ms | 62 to 75 ms | 30 to 34 ms |
| Idle memory after 10 s | 68 MB | 113 MB | 51 MB | 32 MB |
| Bytes per timer tick | 62 | about 2,400 | 18 | 90 |
| Alternate screen | yes | no | yes | yes (by hand) |
| Timer flicker | none: diffs cells, wraps each frame in synchronized output | repaints all 24 lines every tick, wrapped in synchronized output | none: diffs cells | none: diffs rows |
| Resize | relayouts, no clear | relayouts, repaints | clears and repaints | clears and repaints |
| App lines | 56 | 61 | 40 | 130 |
| Types | shipped, strict passes | shipped, strict passes | none; `@types/blessed` is incomplete (`list.selected` missing) | n/a |

Notes from the runs:

- **OpenTUI** worked first try. It ships a native Zig binary per platform (only the
  current one is installed) and enables mouse reporting by default. Its
  `SelectRenderable` handled arrow keys and scrolling with no code. Idle CPU was zero.
- **Ink** never enters the alternate screen. It erases and rewrites its whole output
  on every render, so each tick wrote about 2,400 bytes and 24 line erases. Terminals
  that honour synchronized output hide this; others flicker. Output as tall as the
  terminal also scrolls the shell history, so the app had to stay one row shorter.
- **neo-blessed** ran on Bun with the smallest output of all, but its last release is
  from June 2018 and the fork [reblessed](https://www.npmjs.com/package/reblessed)
  stopped in February 2023. Borders use the DEC line-drawing charset. No bundled types.
- **No library** took 130 lines. The painful parts, in order: display width (a code
  point table was needed for box-drawing and arrow characters, and emoji would still be
  wrong), key parsing (the pseudo-terminal delivered several keys in one chunk, so a
  parser must split sequences), and resize (Bun emits `resize` on stdout, but a clean
  redraw needs the previous frame discarded).

A harness note: `expect` takes only whole-second timeouts. Before working around that,
keys arrived in one batch and looked like a Bun input bug. It was not.

## Read, not run

- **opencode** ([repo](https://github.com/anomalyco/opencode), `packages/tui`) uses
  `@opentui/solid` with `@opentui/keymap`. State lives in Solid stores behind small
  context providers (`src/context/data.tsx`, `route.tsx`, `sync.tsx`); screens are
  `src/routes/*`; reusable widgets are `src/component/*`; keyboard bindings are
  declared in a keymap with modes and a leader key (`src/keymap.tsx`). Rendering is
  entirely OpenTUI's; the app never writes escape codes.
- **critique** ([repo](https://github.com/remorses/critique), `cli/`) uses a fork of
  OpenTUI (`@opentuah/core` and `@opentuah/react`) with React and a
  [zustand](https://www.npmjs.com/package/zustand) store (`cli/src/store.ts`) for
  persisted UI state; views are React components under `cli/src/components`.
- A curated list of OpenTUI projects: [awesome-opentui](https://github.com/msmps/awesome-opentui).

## Recommendation

Use `@opentui/core` directly, without React or Solid.

- It is the only maintained option of the three (last release September 7, 2026), and
  the largest Bun TUI in the wild runs on it.
- Its renderer solves exactly what made the no-library version long: cell diffing,
  unicode width, key parsing, resize, alternate screen.
- The imperative core API fits this project's style: objects that hold state, events
  for input, no framework. The React and Solid layers add a reconciler and a second
  mental model for no gain in a roster-plus-log view.
- Ink needs React and its no-alternate-screen model is a poor fit for a full-screen
  inspector. neo-blessed is unmaintained and untyped.

Costs to state up front: about 27 MB of runtime files plus a 23 MB TypeScript install
that arrives as a peer dependency; a native binary per platform; mouse reporting on by
default (`useMouse: false` exists in the type declarations; not tested). If those are
unacceptable, the fallback is the no-library version with a real width table, not Ink
or blessed.

Trial sources are in the session scratch directory, not in this repository.
