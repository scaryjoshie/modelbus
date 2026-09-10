# modelbus

Local message bus between the AI agents on one machine. TypeScript on Bun.

## Read this first

`docs/architecture.md` describes the running code. `docs/runtime-and-providers.md`
records Joshua's current direction and explicitly separates implemented behavior
from open questions. `docs/poc-spec.md` records the original POC; `docs/design-notes.md`
is an exploratory draft, not a spec. Before implementing
anything that touches an OPEN item, or making a design choice the docs don't settle,
**ask Joshua**. Do not resolve open questions on your own.

## Layout and the layering rule

Core is what would exist with zero known hosts. `scripts/check-layers.ts` enforces it.

| Layer | Files | May import from |
|---|---|---|
| core | `src/core/*` (store, api, limits, schema, delivery, paths) | core only |
| helpers | `src/util/*` (process table, transcript watcher) | util only |
| runtime | `src/runtime/*` (provider contract, discovery, provider manager) | core, util, runtime |
| providers | `src/providers/<host>/*` | own folder, util, runtime/provider, core/delivery, core/paths |
| clients | `src/cli.ts`, `src/mcp.ts`, `src/identity.ts`, `src/client.ts`, `src/ensure.ts` | anything |
| composition roots | `src/daemon.ts`, `src/providers/index.ts` | anything |

Providers are the only place a host's name may appear. Each provider is a folder:
`index.ts` (the class), the host's layout, and `configure.ts` (what `init` writes).
The runtime owns the provider contract; providers never import core API/store or
runtime implementations. Discovery and communication are separate capabilities.
Grouping operations in a provider does not force them to run together.

## How we work

Every addition is deliberate. Before adding anything, say what it is for and what
would consume it today. This is the working method, not a preference:

- Extract the core of a need before designing for it. Ask what the thing *is*,
  apart from its first use case. Identity is not proof; a line is not a host;
  observing a session is not registering it. Keep distinct concepts distinct even
  when one class happens to hold both.
- A shared contract carries facts, not decisions. The consumer chooses
  presentation, policy, and behavior. The test: does this assume the consumer will
  use it one particular way? If so, hand over the data and let them decide.
- Nothing speculative. No field nothing reads, no hook nothing calls, no framework
  for a second case that does not exist. Generalize when the second consumer
  arrives, not before.
- Names mean what they guarantee. When a name overpromises, prefer renaming it or
  documenting the real guarantee to adding machinery that makes the name true.
- Say exactly what will be implemented before implementing it: a short list of what
  changes and what is explicitly left out. Docs separate *as built* from
  *direction* from *open*. A proposed interface never reads as a decision.
- Open questions are Joshua's. A "reasonable default" on an open item is the wrong
  call, not a shortcut. Ask, then wait.
- Removal is progress. Most cleanup commits here delete more than they add. If a
  thing earns nothing today, take it out.
- Verify against the running code and the real hosts before stating a fact.
  Documentation establishes possibilities, not working integrations.

## Public repo

This repository is public. Nothing personal about its author goes in: no absolute
home paths, email addresses, machine or workspace names, session titles, or
descriptions of what is running on any particular machine. Write paths relative to
the checkout or as `~/...`. Examples use invented names.

## Conventions

Follow the TypeScript handbook's Do's and Don'ts, the Google TypeScript style guide,
and Effective TypeScript. Concretely, in this repo:

- `strict`, ESM only, Biome for format and lint (`bun run check` runs everything).
- Validate at the edges with zod (RPC params, host files); trust types inside.
- Results are typed unions, never strings: see `DeliveryResult`. Errors are thrown
  `ApiError` (caller's fault) or plain `Error` (ours).
- No `any`, no non-null assertions, no dynamic `import()` to dodge cycles.
- Small files with one responsibility. Classes only for things that hold state.
- The store is the only module that touches *our* SQL (a provider may read its
  host's own database). Schema lives in `src/core/schema.ts`;
  change it, then `bun run migrate:generate`, and commit the migration. Store only
  what must survive a restart; presence is in memory. Don't add columns nothing reads.
- Numbers callers can tune are options with exported defaults (`src/core/limits.ts`);
  the library takes them, the daemon passes them in, nothing reads env vars or
  config files below the composition root. A timing local to one module is a named
  constant at the top of that module, with its unit in the name.
- Core never runs a command on an agent's behalf. Providers talk to their hosts'
  own doors; a registered process holds its own line by calling `pull`.
- Tool surface for agents stays tiny; context cost matters more than features.
- Nothing may move the mouse, click, steal focus, or raise a window on the user's screen.
- Models never poll. The bus delivers; `sync` exists only as an explicit catch-up.
