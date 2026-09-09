# modelbus

Local message bus between the AI agents on one machine. TypeScript on Bun.

## Read this first

`docs/poc-spec.md` is the current POC spec (DM-only, no UI). `docs/design-notes.md` is
an exploratory draft, not a spec: items marked OPEN are undecided. Before implementing
anything that touches an OPEN item, or making a design choice the docs don't settle,
**ask Joshua**. Do not resolve open questions on your own.

## Layout and the layering rule

Core is what would exist with zero known hosts. `scripts/check-layers.ts` enforces it.

| Layer | Files | May import from |
|---|---|---|
| core | `src/core/*` (store, api, guards, adapter interface, schema, delivery, paths) | core only |
| helpers | `src/util/*` (process table, transcript watcher) | util only |
| adapters | `src/adapters/*`, one file per host | core, util |
| clients | `src/cli.ts`, `src/mcp.ts`, `src/identity.ts`, `src/client.ts`, `src/ensure.ts` | anything |
| composition root | `src/daemon.ts`, `src/tracker.ts` | anything |

Adapters are the only place a host's name may appear. Each adapter is a folder:
`index.ts` (the class), the host's layout, and `configure.ts` (what `init` writes).

## Conventions

Follow the TypeScript handbook's Do's and Don'ts, the Google TypeScript style guide,
and Effective TypeScript. Concretely, in this repo:

- `strict`, ESM only, Biome for format and lint (`bun run check` runs everything).
- Validate at the edges with zod (RPC params, host files); trust types inside.
- Results are typed unions, never strings: see `DeliveryResult`. Errors are thrown
  `ApiError` (caller's fault) or plain `Error` (ours).
- No `any`, no non-null assertions, no dynamic `import()` to dodge cycles.
- Small files with one responsibility. Classes only for things that hold state.
- The store is the only module that touches *our* SQL (an adapter may read its
  host's own database). Schema lives in `src/core/schema.ts`;
  change it, then `bun run migrate:generate`, and commit the migration. Store only
  what must survive a restart; presence is in memory. Don't add columns nothing reads.
- Protocol limits live in `src/core/guards.ts`; a timing local to one module is a
  named constant at the top of that module, with its unit in the name.
- Core never runs a command on an agent's behalf. Adapters talk to their hosts'
  own doors; a registered process holds its own line by calling `pull`.
- Tool surface for agents stays tiny; context cost matters more than features.
- Nothing may move the mouse, click, steal focus, or raise a window on the user's screen.
- Models never poll. The bus delivers; `sync` exists only as an explicit catch-up.
