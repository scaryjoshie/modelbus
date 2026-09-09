import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { allAdapters } from "./adapters/index.ts";
import { RegisteredAdapter } from "./adapters/registered.ts";
import type { HostAdapter } from "./core/adapter.ts";
import { Api, ApiError } from "./core/api.ts";
import { dbPath, socketPath } from "./core/paths.ts";
import { Store } from "./core/store.ts";
import { Tracker } from "./tracker.ts";

/**
 * The daemon is the composition root: one Store, one Api, one Tracker over the
 * configured adapters, one HTTP-over-unix-socket endpoint. Clients POST /rpc with
 * { method, params, identity }. The method table below is the protocol.
 *
 * Identity on the wire:
 *   - { kind: "cli", as }                         test-only override
 *   - { kind: "self", host, key, name, evidence } a session identifying itself
 *   - { kind: "token", token }                    a self-registered process
 */

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
type Identity = z.infer<typeof Identity>;

const Envelope = z.object({
  method: z.string(),
  params: z.record(z.string(), z.unknown()).default({}),
  identity: Identity.optional(),
});

interface Method<P> {
  params: z.ZodType<P>;
  /** Whether the caller must identify itself. */
  identity: boolean;
  handler(params: P, agentId: string | undefined): Promise<unknown> | unknown;
}

const method = <P>(m: Method<P>) => m;

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

  function resolveIdentity(identity: Identity | undefined): string {
    if (!identity) throw new ApiError("identity required");
    switch (identity.kind) {
      case "cli":
        return store.bind({
          host: "cli",
          key: identity.as,
          handle: { as: identity.as },
          durability: "permanent",
          preferredName: identity.as,
          evidence: "cli --as (test identity)",
          attestation: "attested",
        }).id;
      case "token": {
        const h = store.handleByKey("registered", identity.token);
        if (!h) throw new ApiError("unknown token; register first");
        registered.touch(identity.token);
        store.touch(h.agentId);
        return h.agentId;
      }
      case "self":
        return tracker.identify({ ...identity, evidence: identity.evidence ?? "self-identified" })
          .id;
    }
  }

  /** The protocol. Each entry validates its params and runs with the resolved caller. */
  const methods = {
    ping: method({
      params: z.object({}),
      identity: false,
      handler: () => ({ ok: true, pid: process.pid }),
    }),
    bind: method({
      params: z.object({}),
      identity: true,
      handler: (_p, id) => ({ agent: store.agentById(id as string) }),
    }),
    attach: method({
      params: z.record(z.string(), z.unknown()),
      identity: true,
      handler: (p, id) => ({
        agent: store.agentById(id as string),
        attached: tracker.attach(id as string, p),
      }),
    }),
    register: method({
      params: z.object({
        name: z.string().min(1),
        host: z.string().optional(),
        pid: z.number().int().optional(),
        deliver: z.string().optional(),
      }),
      identity: false,
      handler: (p) => {
        const r = registered.register({ ...p, hostLabel: p.host });
        return { agent: r.agent, token: r.token };
      },
    }),
    send: method({
      params: z.object({ to: z.string(), body: z.string(), wait: z.number().optional() }),
      identity: true,
      handler: async (p, id) => {
        if (!store.agentByName(p.to)) await tracker.reconcile();
        return api.send({ fromId: id as string, ...p });
      },
    }),
    pull: method({
      params: z.object({
        scope: z.string().optional(),
        wait: z.number().optional(),
        limit: z.number().optional(),
      }),
      identity: true,
      handler: (p, id) => api.pull({ agentId: id as string, ...p }),
    }),
    who: method({
      params: z.object({ filter: z.string().optional(), fresh: z.boolean().optional() }),
      identity: false,
      handler: async (p) => {
        if (p.fresh) await tracker.reconcile();
        return { agents: tracker.list(p.filter) };
      },
    }),
    log: method({
      params: z.object({ a: z.string().optional(), b: z.string().optional() }),
      identity: false,
      handler: (p) => ({ rows: api.log(p) }),
    }),
  };

  async function handle(req: Request): Promise<Response> {
    if (req.method !== "POST" || new URL(req.url).pathname !== "/rpc") {
      return Response.json({ error: "POST /rpc only" }, { status: 404 });
    }
    let env: z.infer<typeof Envelope>;
    try {
      env = Envelope.parse(await req.json());
    } catch (e) {
      return Response.json({ error: `bad request: ${String(e)}` }, { status: 400 });
    }
    const m = (methods as unknown as Record<string, Method<unknown>>)[env.method];
    if (!m) return Response.json({ error: `unknown method ${env.method}` }, { status: 404 });
    try {
      const params = m.params.parse(env.params);
      const agentId = m.identity ? resolveIdentity(env.identity) : undefined;
      return Response.json(await m.handler(params, agentId));
    } catch (e) {
      const status = e instanceof ApiError ? 422 : e instanceof z.ZodError ? 400 : 500;
      return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status });
    }
  }

  const unix = opts.unix ?? socketPath();
  mkdirSync(dirname(unix), { recursive: true });
  if (existsSync(unix)) unlinkSync(unix);
  // idleTimeout must exceed the longest long-poll; Bun's unix-socket option type
  // omits it, so the options object is cast.
  const server = Bun.serve({ unix, idleTimeout: 255, fetch: handle } as unknown as Parameters<
    typeof Bun.serve
  >[0]);

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
  console.log(`modelbus daemon pid ${process.pid} on ${d.unix}, db ${dbPath()}`);
  const shutdown = () => {
    d.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
