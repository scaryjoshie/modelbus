# modelbus

Local message bus for coding agents. Design phase; no code yet.

## Read this first

`docs/poc-spec.md` is the current POC proposal (DM-only, no UI). It is more concrete
than the notes but still not settled; items marked OPEN are undecided.

`docs/design-notes.md` is an **exploratory draft**, not a spec. It records ideas from
design conversations, many unfinished, with items marked OPEN and LEANING. Do not treat
it as decisions. Before implementing anything that touches an OPEN item, or before
making a design choice the notes don't clearly settle, **ask Joshua**. Do not resolve
open questions on your own.

`docs/host-adapter-inventory-and-bus-design.md` is an external research report on
per-host integration mechanisms and prior art. Some of its claims are flagged as
unverified inside the doc itself.

## Conventions (current leaning, confirm before relying on them)

- TypeScript on Bun. `strict: true`, ESM only, Biome for format and lint, zod at
  boundaries. Otherwise idiomatic TypeScript.
- Keep code legible to someone coming from Python. No clever generics.
- Tool surface for agents must stay tiny; context cost matters more than features.
- Nothing may move the mouse, click, steal focus, or raise a window on the user's screen.
