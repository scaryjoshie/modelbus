# TUI libraries for TypeScript on Bun

Status: research, September 2026. Versions and dates were checked against the
npm registry and GitHub on the day of writing and will drift.

| Library | Latest | Published | Bun | Deps | Rendering | Layout |
|---|---|---|---|---|---|---|
| @opentui/core | 0.5.11 | 2026-09-07 | Bun-first | 5 + native binary | retained tree, native cell buffer, diffed | flexbox (Yoga) |
| ink | 7.1.1 | 2026-07-16 | works, open Bun bugs | 25 (React, Yoga wasm) | tree to text, line rewrite | flexbox (Yoga) |
| @earendil-works/pi-tui | 0.85.1 | 2026-09-05 | not stated | 2 | retained components, diffed lines | stacks, scroll view |
| terminal-kit | 3.1.4 | 2026-07-19 | early bugs fixed 2023 | 8 | screen buffer, delta draw | coordinates |
| blessed | 0.1.81 | 2015-09-03 | untested | 0 | retained widgets | coordinates |
| reblessed | 0.2.1 | 2023-02-12 | untested | 0 | as blessed | as blessed |
| @clack/prompts | 1.8.0 | 2026-09-07 | yes | 4 | prompts only | none |

## OpenTUI

[OpenTUI](https://github.com/anomalyco/opentui) is TypeScript over a native Zig
core, from the opencode team; opencode's TUI depends on `@opentui/core` and
`@opentui/solid`
([package.json](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/package.json)).
The [core README](https://github.com/anomalyco/opentui/blob/main/packages/core/README.md)
says it "runs on Bun 1.3.0 or later, or on Node.js 26.4.0 or later with ESM and
`--experimental-ffi`" (Node support: [PR #1410](https://github.com/anomalyco/opentui/pull/1410),
August 2026).

Rendering is retained: a tree of renderables, a native cell buffer, and only
the difference written. The renderer defaults to 30 frames per second, debounces
resize by 100 ms, enables mouse by default, and can enable the Kitty keyboard
protocol ([renderer.ts](https://github.com/anomalyco/opentui/blob/main/packages/core/src/renderer.ts)).
The native side uses the alternate screen (1049), SGR mouse (1006), bracketed
paste (2004) and synchronized output (2026) with DECRQM detection
([ansi.zig](https://github.com/anomalyco/opentui/blob/main/packages/native/src/ansi.zig)).
Layout is flexbox through Yoga
([yoga.options.ts](https://github.com/anomalyco/opentui/blob/main/packages/core/src/lib/yoga.options.ts)).

Weight: about 13.7 MB unpacked, plus a 5 to 6 MB platform binary from one of
eight optional packages, plus a `web-tree-sitter` peer dependency
([npm](https://www.npmjs.com/package/@opentui/core)). Pre-1.0, with 329
versions in 13 months. Open problems: tmux capability replies leaking into
other panes ([#1459](https://github.com/anomalyco/opentui/issues/1459)), Kitty
keyboard regressions on some Windows layouts
([#1042](https://github.com/anomalyco/opentui/issues/1042)). 134 open issues,
13k stars, pushed the day before writing.

## Ink

[Ink](https://github.com/vadimdemedes/ink) is a React renderer for the terminal.
7.0.0 (April 2026) requires Node 22 and React 19.2
([releases](https://github.com/vadimdemedes/ink/releases)); 25 runtime
dependencies including `react-reconciler` and `yoga-layout` (WebAssembly).
The tree is laid out with Yoga, turned into text, and rewritten; `maxFps`
defaults to 30, `incrementalRendering` is off by default, `alternateScreen`
arrived in 7.0 ([readme](https://github.com/vadimdemedes/ink/blob/master/readme.md)).
Output as tall as the terminal forces a clear and full redraw, its best-known
flicker source ([#450](https://github.com/vadimdemedes/ink/issues/450),
[#621](https://github.com/vadimdemedes/ink/discussions/621)); resize can leave
artifacts ([#907](https://github.com/vadimdemedes/ink/issues/907)). Input is
`useInput` with a key object; focus is `useFocus`.

Bun: Ink's "Bun support" issue closed in 2023 by deferring to Bun's tracker
([#636](https://github.com/vadimdemedes/ink/issues/636)). Still open there: the
cursor stays hidden after an Ink app exits on macOS
([bun #26642](https://github.com/oven-sh/bun/issues/26642)) and memory growth in
long-lived Ink apps ([bun #28234](https://github.com/oven-sh/bun/issues/28234)).
A regex slowdown that "cripples Ink TUIs" was fixed in August 2026
([bun #37290](https://github.com/oven-sh/bun/issues/37290)). 39.8k stars, active.

## pi-tui

[pi-tui](https://github.com/earendil-works/pi/blob/main/packages/tui/README.md)
is the UI layer of the pi coding agent, now `@earendil-works/pi-tui` (the older
`@mariozechner/pi-tui` stopped in May 2026). "Minimal terminal UI framework
with differential rendering and synchronized output." `TuiMainScreen` keeps
scrollback; `TuiAltScreen` owns a viewport with `VStack`, `HStack`,
`ScrollView`. Kitty keyboard and SGR mouse supported. Components implement
`render(width)` and optional `handleInput`. Dependencies: `marked`,
`get-east-asian-width`; engines say Node 22.19, Bun is not mentioned. Releases
follow the pi monorepo.

## terminal-kit

[terminal-kit](https://github.com/cronvel/terminal-kit): low-level calls, a
`ScreenBuffer` with delta drawing, and a widget "document model"
([docs](https://github.com/cronvel/terminal-kit/blob/master/doc/documentation.md)).
CommonJS with community typings only, 8 dependencies, single maintainer, Node 16.13 or later. Early Bun
runs failed on TTY detection ([bun #2040](https://github.com/oven-sh/bun/issues/2040),
closed 2023). Elements are placed by coordinates, no flexbox.

## blessed, neo-blessed, reblessed

[blessed](https://github.com/chjj/blessed) last shipped in 2015 with 256 open
issues; wide characters and emoji have broken its layout from the start
([#4](https://github.com/chjj/blessed/issues/4),
[#123](https://github.com/chjj/blessed/issues/123)). neo-blessed
([npm](https://www.npmjs.com/package/neo-blessed)) is a 2018 fork, repo last
pushed 2021; [reblessed](https://github.com/kenan238/reblessed) forks that,
last published February 2023, pushed June 2024. All CommonJS, typed only
through DefinitelyTyped, no Bun statement. Not viable for new work.

## @clack/prompts

[clack](https://github.com/bombshell-dev/clack) reached 1.0 in January 2026.
A prompt library (text, select, spinner), not a screen manager, with four small
dependencies. Right for a question in `modelbus init`, not for a full-screen view.

## Others

`tuir` is an Ink fork last published March 2025; `melker` is Deno-first with
23 stars. Neither is a credible base.
