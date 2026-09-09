import { allAdapters } from "./adapters/index.ts";
import type { Identity } from "./client.ts";

/**
 * Who am I? Asked by the MCP shim and the CLI from inside some process. Order:
 *  0. an explicit --as override (test only): a self identity on the pseudo-host "cli";
 *  1. a registration token (MODELBUS_TOKEN), for self-registered processes;
 *  2. a configured identity (MODELBUS_HOST/KEY/NAME), for hosts that spawn one shim
 *     for many sessions and name it in its environment;
 *  3. whichever host adapter recognizes the process it is running inside;
 *  4. the test-only MODELBUS_AS override.
 * Host-specific knowledge lives only in the adapters.
 */
export async function whoAmI(opts: { as?: string } = {}): Promise<{
  identity: Identity;
  label: string;
  attach?: Record<string, unknown>;
}> {
  const testIdentity = (as: string) => ({
    identity: { kind: "self" as const, host: "cli", key: as, name: as },
    label: `${as} (test identity)`,
  });
  if (opts.as) return testIdentity(opts.as);
  if (process.env.MODELBUS_TOKEN) {
    return { identity: { kind: "token", token: process.env.MODELBUS_TOKEN }, label: "registered" };
  }
  const { MODELBUS_HOST, MODELBUS_KEY, MODELBUS_NAME } = process.env;
  if (MODELBUS_HOST && MODELBUS_KEY && MODELBUS_NAME) {
    return {
      identity: { kind: "self", host: MODELBUS_HOST, key: MODELBUS_KEY, name: MODELBUS_NAME },
      label: MODELBUS_NAME,
    };
  }
  for (const adapter of allAdapters()) {
    const me = adapter.identifySelf ? await adapter.identifySelf() : null;
    if (!me) continue;
    return {
      identity: { kind: "self", host: me.host, key: me.key, name: me.name },
      label: me.name,
      attach: me.attach,
    };
  }
  if (process.env.MODELBUS_AS) return testIdentity(process.env.MODELBUS_AS);
  throw new Error("not inside a known host session; register, or pass --as <name> for testing");
}
