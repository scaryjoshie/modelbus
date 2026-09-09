import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { allAdapters } from "./adapters/index.ts";
import { RegisteredAdapter } from "./adapters/registered.ts";
import type { HostAdapter } from "./core/adapter.ts";
import { Api, ApiError } from "./core/api.ts";
import { Store } from "./core/store.ts";
import { Tracker } from "./tracker.ts";

/**
 * The daemon: one Store, one Api, one Tracker over the host adapters, one
 * HTTP-over-unix-socket endpoint. Clients POST /rpc with {method, params, identity}.
 *
 * Identity on the wire:
 *   - { kind: "cli", as }                         test-only (spec section 6)
 *   - { kind: "self", host, key, name, evidence } a session identifying itself via its
 *     hook or shim; `key` is the adapter's opaque key. The core never reads it.
 *   - { kind: "token", token }                     a self-registered process
 */

export function modelbusHome(): string {
  return process.env.MODELBUS_HOME ?? join(homedir(), ".modelbus");
}
export function socketPath(): string {
  return join(modelbusHome(), "daemon.sock");
}
export function dbPath(): string {
  return join(modelbusHome(), "modelbus.db");
}

const Identity = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("cli"), as: z.string().min(1) }),
  z.object({
    kind: z.literal("self"),
    host: z.string().min(1),
    key: z.string().min(1),
    name: z.string().min(1),
    evidence: z.string().optional(),
  }),
  z.object({ kind: z.literal("token"), token: z.string().min(8) }),
]);

const Request = z.object({
  method: z.enum(["send", "pull", "who", "log", "bind", "attach", "register", "ping"]),
  params: z.record(z.string(), z.unknown()).default({}),
  identity: Identity.optional(),
});

export function createDaemon(
  opts: { store?: Store; unix?: string; adapters?: HostAdapter[]; track?: boolean } = {},
) {
  const store = opts.store ?? new Store(dbPath());
  const api = new Api(store);
  const registered = new RegisteredAdapter(store);
  const tracker = new Tracker(store, opts.adapters ?? allAdapters(store));
  api.setDeliver((agent, text, marker, onReceipt) =>
    tracker.deliver(agent, text, marker, onReceipt),
  );
  if (opts.track !== false) tracker.start();

  const unix = opts.unix ?? socketPath();
  mkdirSync(join(unix, ".."), { recursive: true });
  if (existsSync(unix)) unlinkSync(unix);

  function resolveIdentity(identity: z.infer<typeof Identity> | undefined): string {
    if (!identity) throw new ApiError("identity required");
    if (identity.kind === "cli") {
      return store.bind({
        host: "cli",
        key: identity.as,
        handle: { as: identity.as },
        durability: "permanent",
        preferredName: identity.as,
        evidence: "cli --as (test identity)",
        attestation: "attested",
      }).id;
    }
    if (identity.kind === "token") {
      const h = store.handleByKey("registered", identity.token);
      if (!h) throw new ApiError("unknown token; register first");
      registered.touch(identity.token);
      store.touch(h.agent_id);
      return h.agent_id;
    }
    return tracker.identify({
      host: identity.host,
      key: identity.key,
      name: identity.name,
      evidence: identity.evidence ?? "self-identified",
    }).id;
  }

  // idleTimeout must exceed the longest long-poll (GUARDS.MAX_WAIT_SECONDS); Bun's
  // unix-socket option type omits it, so the options object is cast.
  const options = {
    unix,
    idleTimeout: 255,
    async fetch(req: Request) {
      if (req.method !== "POST" || new URL(req.url).pathname !== "/rpc") {
        return Response.json({ error: "POST /rpc only" }, { status: 404 });
      }
      let parsed: z.infer<typeof Request>;
      try {
        parsed = Request.parse(await req.json());
      } catch (e) {
        return Response.json(
          { error: `bad request: ${e instanceof Error ? e.message : e}` },
          { status: 400 },
        );
      }
      const { method, params, identity } = parsed;
      try {
        switch (method) {
          case "ping":
            return Response.json({ ok: true, pid: process.pid });
          case "bind": {
            const id = resolveIdentity(identity);
            return Response.json({ agent: store.agentById(id) });
          }
          case "register": {
            // Any process joins by name; gets a token that is its identity from now on.
            const p = z
              .object({
                name: z.string().min(1),
                host: z.string().optional(),
                pid: z.number().int().optional(),
                deliver: z.string().optional(),
              })
              .parse(params);
            const r = registered.register({
              name: p.name,
              hostLabel: p.host,
              pid: p.pid,
              deliver: p.deliver,
            });
            return Response.json({ agent: r.agent, token: r.token });
          }
          case "attach": {
            // A session hands over runtime info its adapter needs (e.g. socket + token).
            // Secrets stay in the adapter's memory; nothing here is persisted.
            const id = resolveIdentity(identity);
            const attached = tracker.attach(id, params);
            return Response.json({ agent: store.agentById(id), attached });
          }
          case "send": {
            const fromId = resolveIdentity(identity);
            const p = z
              .object({ to: z.string(), body: z.string(), wait: z.number().optional() })
              .parse(params);
            if (!store.agentByName(p.to)) await tracker.reconcile();
            return Response.json(await api.send({ fromId, ...p }));
          }
          case "pull": {
            const agentId = resolveIdentity(identity);
            const p = z
              .object({
                scope: z.string().optional(),
                wait: z.number().optional(),
                limit: z.number().optional(),
              })
              .parse(params);
            return Response.json(await api.pull({ agentId, ...p }));
          }
          case "who": {
            const p = z
              .object({ filter: z.string().optional(), fresh: z.boolean().optional() })
              .parse(params);
            if (p.fresh) await tracker.reconcile();
            return Response.json({ agents: tracker.list(p.filter) });
          }
          case "log": {
            const p = z
              .object({ a: z.string().optional(), b: z.string().optional() })
              .parse(params);
            return Response.json({ rows: api.log(p) });
          }
        }
      } catch (e) {
        const status = e instanceof ApiError ? 422 : 500;
        return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status });
      }
      return Response.json({ error: "unreachable" }, { status: 500 });
    },
  };
  const server = Bun.serve(options as unknown as Parameters<typeof Bun.serve>[0]);

  return {
    api,
    store,
    tracker,
    unix,
    stop() {
      tracker.stop();
      server.stop(true);
      store.close();
      if (existsSync(unix)) unlinkSync(unix);
    },
  };
}

if (import.meta.main) {
  const d = createDaemon();
  console.log(`modelbus daemon pid ${process.pid} listening on ${d.unix}, db ${dbPath()}`);
  const shutdown = () => {
    d.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
