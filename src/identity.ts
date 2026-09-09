import { allAdapters } from "./adapters/index.ts";
import type { Identity } from "./client.ts";
import type { SelfIdentity } from "./core/adapter.ts";

/**
 * Who am I? Asked by the MCP shim and the CLI from inside some process. Order:
 *  0. an explicit --as override (test only);
 *  1. a registration token (MODELBUS_TOKEN), for self-registered processes;
 *  2. a configured identity (MODELBUS_HOST/KEY/NAME), for hosts that spawn one shim
 *     for many sessions and name it in its environment;
 *  3. whichever host adapter recognizes the process it is running inside;
 *  4. the test-only --as / MODELBUS_AS override.
 * Host-specific knowledge lives only in the adapters.
 */
export async function whoAmI(opts: { as?: string } = {}): Promise<{
  identity: Identity;
  label: string;
  attach?: Record<string, unknown>;
}> {
  if (opts.as)
    return { identity: { kind: "cli", as: opts.as }, label: `${opts.as} (test identity)` };
  if (process.env.MODELBUS_TOKEN) {
    return { identity: { kind: "token", token: process.env.MODELBUS_TOKEN }, label: "registered" };
  }
  const { MODELBUS_HOST, MODELBUS_KEY, MODELBUS_NAME } = process.env;
  if (MODELBUS_HOST && MODELBUS_KEY && MODELBUS_NAME) {
    return {
      identity: {
        kind: "self",
        host: MODELBUS_HOST,
        key: MODELBUS_KEY,
        name: MODELBUS_NAME,
        evidence: "configured environment",
      },
      label: MODELBUS_NAME,
    };
  }
  for (const adapter of allAdapters()) {
    const me: SelfIdentity | null = adapter.identifySelf ? await adapter.identifySelf() : null;
    if (!me) continue;
    return {
      identity: { kind: "self", host: me.host, key: me.key, name: me.name, evidence: me.evidence },
      label: me.name,
      attach: me.attach,
    };
  }
  const as = process.env.MODELBUS_AS;
  if (as) return { identity: { kind: "cli", as }, label: `${as} (test identity)` };
  throw new Error("not inside a known host session; register, or pass --as <name> for testing");
}
