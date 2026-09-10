# Decision: no TUI library

Made 2026-09-10 by the Claude session building the TUI, while the author was
away, from the two reports in this folder. Reversible; the architecture keeps
the view functions separate so a library can be slotted in later.

Two reports were written independently. `recommendation.md` worked from
documentation and recommends a hand-written renderer with no dependencies.
`second-opinion.md` installed and ran every candidate on Bun in a pseudo-terminal
and recommends `@opentui/core` used imperatively, with the hand-written renderer
as its fallback. They agree on the facts: every candidate runs on Bun today; the
hand-written route took about 130 lines for the trial app, with unicode width
and key parsing as the only tedious parts; OpenTUI has the best rendering but
costs a 6 MB native binary, a 49 MB install (23 MB of it a TypeScript peer
dependency), a 0.5.x API, and mouse on by default.

The choice is the hand-written renderer, for these reasons:

- The screen is fixed regions: a list, a detail pane, a log, a filter line, a
  help overlay. There is no layout engine to need.
- Bun supplies string width and color-depth detection, which are the two parts
  that made the no-library route painful in the trial.
- The project rule is that a dependency must say what it replaces. A native
  binary and a 49 MB install replace roughly three hundred lines of TypeScript
  that can be tested without a terminal.

If the TUI grows a text editor, mouse support, or more than a handful of
widgets, switch to `@opentui/core` without React or Solid. Both reports name it
as the right second choice.
