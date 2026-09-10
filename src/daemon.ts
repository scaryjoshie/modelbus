import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { Api, ApiError } from "./core/api.ts";
import type { Limits } from "./core/limits.ts";
import { dbPath, ensureHome, modelbusHome, socketPath } from "./core/paths.ts";
import { newId, Store } from "./core/store.ts";
import { allProviders } from "./providers/index.ts";
import type { Provider } from "./runtime/provider.ts";
import { ProviderManager } from "./runtime/provider-manager.ts";
import { fileSecrets } from "./runtime/secrets.ts";

/**
 * The daemon is the composition root: one Store, one Api, one ProviderManager over the
 * configured providers, one HTTP-over-unix-socket endpoint. Clients POST /rpc with
 * { method, params, identity }. The method table below is the protocol; the client
 * derives its types from it.
 *
 * Identity on the wire:
 *   - { kind: "self", host, key, name }  a session identifying itself
 *   - { kind: "token", id, secret }      a self-registered process (id names, secret proves)
 */

/** Bun's maximum. Must exceed the longest long-poll. */
const IDLE_TIMEOUT_SECONDS = 255;
/** The host of processes that joined via `register`; nobody observes them, they call in. */
const REGISTERED_HOST = "registered";

export const Identity = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("self"),
    host: z.string().min(1),
    key: z.string().min(1),
    name: z.string().min(1),
  }),
  z.object({ kind: z.literal("token"), id: z.string().min(1), secret: z.string() }),
]);
export type Identity = z.infer<typeof Identity>;

const Envelope = z.object({
  method: z.string(),
  params: z.record(z.string(), z.unknown()).default({}),
  identity: Identity.optional(),
});

/** A method anyone may call. */
const open = <S extends z.ZodType, R>(m: {
  params: S;
  handler(params: z.infer<S>): R | Promise<R>;
}) => ({ ...m, identity: false as const });

/** A method that runs as the identified caller. */
const authed = <S extends z.ZodType, R>(m: {
  params: S;
  handler(params: z.infer<S>, agentId: string): R | Promise<R>;
}) => ({ ...m, identity: true as const });

interface AnyMethod {
  params: z.ZodType;
  identity: boolean;
  handler(params: unknown, agentId?: string): unknown;
}

function buildMethods(store: Store, api: Api, providerManager: ProviderManager) {
  /** Clients address agents by display name; core only knows ids. */
  const agentNamed = (name: string): Agent => {
    const agent = store.agentByName(name);
    if (!agent) throw new ApiError(`no agent named "${name}"; try who`);
    return agent;
  };
  return {
    ping: open({ params: z.object({}), handler: () => ({ ok: true, pid: process.pid }) }),
    bind: authed({
      params: z.object({}),
      handler: (_p, id) => ({ agent: store.agentById(id) as Agent }),
    }),
    attach: authed({
      params: z.record(z.string(), z.unknown()),
      handler: (p, id) => {
        const agent = store.agentById(id) as Agent;
        return { agent, attached: providerManager.attach(agent, p) };
      },
    }),
    register: open({
      params: z.object({ name: z.string().min(1) }),
      handler: (p) => {
        // Identity (a fresh non-secret key) and the proof (a secret) are distinct.
        const secret = randomBytes(24).toString("base64url");
        const agent = store.bind({ host: REGISTERED_HOST, key: newId(), name: p.name });
        store.setCredential(agent.id, secret);
        providerManager.touch(agent.id);
        return { agent, token: `${agent.id}.${secret}` };
      },
    }),
    send: authed({
      params: z.object({ to: z.string(), body: z.string(), wait: z.number().optional() }),
      handler: async (p, id) => {
        if (!store.agentByName(p.to)) await providerManager.reconcile();
        return api.send({ fromId: id, toId: agentNamed(p.to).id, body: p.body, wait: p.wait });
      },
    }),
    pull: authed({
      params: z.object({
        scope: z.string().optional(),
        wait: z.number().optional(),
        limit: z.number().optional(),
      }),
      handler: (p, id) =>
        api.pull({
          agentId: id,
          scopeId: p.scope ? agentNamed(p.scope).id : undefined,
          wait: p.wait,
          limit: p.limit,
        }),
    }),
    who: open({
      params: z.object({ filter: z.string().optional(), fresh: z.boolean().optional() }),
      handler: async (p) => {
        // Right after startup the first pass may still be running; a roster
        // from before it finished would be empty.
        await (p.fresh ? providerManager.reconcile() : providerManager.ready());
        return { agents: providerManager.list(p.filter) };
      },
    }),
    log: open({
      params: z.object({ a: z.string().optional(), b: z.string().optional() }),
      handler: (p) => ({
        rows: api.log({
          between: p.a && p.b ? [agentNamed(p.a).id, agentNamed(p.b).id] : undefined,
        }),
      }),
    }),
  };
}

type Agent = NonNullable<ReturnType<Store["agentById"]>>;
/** The protocol, as a type the client can check calls against. */
export type Methods = ReturnType<typeof buildMethods>;

export function createDaemon(
  opts: {
    store?: Store;
    unix?: string;
    providers?: Provider[];
    track?: boolean;
    limits?: Partial<Limits>;
  } = {},
) {
  const store = opts.store ?? new Store(dbPath());
  const api = new Api(store, opts.limits);
  const providerManager = new ProviderManager(
    store,
    opts.providers ??
      allProviders({ secrets: (host) => fileSecrets(join(modelbusHome(), "secrets"), host) }),
  );
  api.setDeliver((to, outbound, onRead) => providerManager.deliver(to, outbound, onRead));
  providerManager.onReachable = (agent) => api.redeliver(agent.id).then(() => undefined);
  if (opts.track !== false) providerManager.start();
  const methods: Record<string, AnyMethod> = buildMethods(store, api, providerManager);

  function resolveIdentity(identity: Identity | undefined): string {
    if (!identity) throw new ApiError("identity required");
    if (identity.kind === "token") {
      const agent = store.agentById(identity.id);
      if (!agent || agent.host !== REGISTERED_HOST)
        throw new ApiError("unknown token; register first");
      if (!store.verifyCredential(agent.id, identity.secret)) throw new ApiError("bad token");
      providerManager.touch(agent.id);
      return agent.id;
    }
    return providerManager.identify(identity).id;
  }

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
    const m = methods[env.method];
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
  mkdirSync(dirname(unix), { recursive: true, mode: 0o700 });
  if (existsSync(unix)) unlinkSync(unix);
  if (api.limits.maxWaitSeconds >= IDLE_TIMEOUT_SECONDS) {
    throw new Error("limits.maxWaitSeconds must be below the socket idle timeout");
  }
  // Bun's unix-socket option type omits idleTimeout, so the options object is cast.
  const server = Bun.serve({
    unix,
    idleTimeout: IDLE_TIMEOUT_SECONDS,
    fetch: handle,
  } as unknown as Parameters<typeof Bun.serve>[0]);
  // Connecting needs write permission on the socket file: owner only.
  chmodSync(unix, 0o600);

  return {
    api,
    store,
    providerManager,
    unix,
    stop() {
      providerManager.stop();
      server.stop(true);
      store.close();
      if (existsSync(unix)) unlinkSync(unix);
    },
  };
}

if (import.meta.main) {
  ensureHome();
  const d = createDaemon();
  console.log(`modelbus daemon pid ${process.pid} on ${d.unix}, db ${dbPath()}`);
  const shutdown = () => {
    d.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
