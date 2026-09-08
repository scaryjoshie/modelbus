import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { Api, ApiError } from "./core/api.ts";
import { Store } from "./core/store.ts";
import { ClaudeCodeWake } from "./providers/claude-code-wake.ts";

/**
 * The daemon: one Store, one Api, one HTTP-over-unix-socket endpoint.
 * Clients POST /rpc with {method, params, identity}. See docs/poc-spec.md section 3.
 *
 * Identity in v0 comes from the caller layer:
 *   - CLI test mode: identity = { kind: "cli", as: "<name>" }  (test only, see spec 6)
 *   - Providers/hook/shim (later): identity = { kind: "binding", host, ref, name }
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
    kind: z.literal("binding"),
    host: z.string().min(1),
    ref: z.string().min(1),
    name: z.string().min(1),
    evidence: z.string().optional(),
  }),
]);

const Request = z.object({
  method: z.enum(["send", "pull", "who", "log", "bind", "attach", "ping"]),
  params: z.record(z.string(), z.unknown()).default({}),
  identity: Identity.optional(),
});

export function createDaemon(opts: { store?: Store; unix?: string } = {}) {
  const store = opts.store ?? new Store(dbPath());
  const api = new Api(store);
  const claudeWake = new ClaudeCodeWake(api);
  api.registerProvider(claudeWake);
  const unix = opts.unix ?? socketPath();
  mkdirSync(join(unix, ".."), { recursive: true });
  if (existsSync(unix)) unlinkSync(unix);

  function resolveIdentity(identity: z.infer<typeof Identity> | undefined): string {
    if (!identity) throw new ApiError("identity required");
    if (identity.kind === "cli") {
      return api.bind({
        host: "cli",
        hostSessionRef: `cli:${identity.as}`,
        preferredName: identity.as,
      }).id;
    }
    return api.bind({
      host: identity.host,
      hostSessionRef: identity.ref,
      preferredName: identity.name,
      evidence: identity.evidence,
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
          case "attach": {
            // A host session hands over what the daemon needs to deliver into it.
            // Secrets stay in the provider's memory; nothing here is persisted.
            const id = resolveIdentity(identity);
            const p = z
              .object({
                sessionId: z.string(),
                socketPath: z.string(),
                token: z.string().optional(),
                transcriptPath: z.string().optional(),
              })
              .parse(params);
            claudeWake.attach(p.sessionId, {
              socketPath: p.socketPath,
              token: p.token,
              transcriptPath: p.transcriptPath,
            });
            return Response.json({ agent: store.agentById(id), attached: true });
          }
          case "send": {
            const fromId = resolveIdentity(identity);
            const p = z
              .object({ to: z.string(), body: z.string(), wait: z.number().optional() })
              .parse(params);
            const r = await api.send({ fromId, ...p });
            return Response.json(r);
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
            const p = z.object({ filter: z.string().optional() }).parse(params);
            return Response.json({ agents: api.who(p.filter) });
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
    unix,
    stop() {
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
