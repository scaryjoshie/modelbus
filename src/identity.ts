import type { Identity } from "./client.ts";
import { allProviders } from "./providers/index.ts";

/** A registration token is `<agentId>.<secret>`: the id names, the secret proves. */
export function parseToken(token: string): Identity {
  const i = token.indexOf(".");
  return i === -1
    ? { kind: "token", id: token, secret: "" }
    : { kind: "token", id: token.slice(0, i), secret: token.slice(i + 1) };
}

/**
 * Who am I? Asked by the MCP shim and the CLI from inside some process. Order:
 *  0. an explicit --as override (test only): a self identity on the pseudo-provider "cli";
 *  1. a registration token (MODELBUS_TOKEN), for self-registered processes;
 *  2. a configured identity (MODELBUS_PROVIDER/KEY/NAME), for hosts that spawn one shim
 *     for many sessions and name it in its environment;
 *  3. whichever host provider recognizes the process it is running inside;
 *  4. the test-only MODELBUS_AS override.
 * Host-specific knowledge lives only in the providers.
 */
export async function whoAmI(opts: { as?: string } = {}): Promise<{
  identity: Identity;
  label: string;
  attach?: Record<string, unknown>;
}> {
  const testIdentity = (as: string) => ({
    identity: { kind: "self" as const, provider: "cli", key: as, name: as },
    label: `${as} (test identity)`,
  });
  if (opts.as) return testIdentity(opts.as);
  if (process.env.MODELBUS_TOKEN) {
    return { identity: parseToken(process.env.MODELBUS_TOKEN), label: "registered" };
  }
  const { MODELBUS_PROVIDER, MODELBUS_KEY, MODELBUS_NAME } = process.env;
  if (MODELBUS_PROVIDER && MODELBUS_KEY && MODELBUS_NAME) {
    return {
      identity: {
        kind: "self",
        provider: MODELBUS_PROVIDER,
        key: MODELBUS_KEY,
        name: MODELBUS_NAME,
      },
      label: MODELBUS_NAME,
    };
  }
  for (const provider of allProviders()) {
    const me = provider.identifySelf ? await provider.identifySelf() : null;
    if (!me) continue;
    return {
      identity: { kind: "self", provider: me.provider, key: me.key, name: me.name },
      label: me.name,
      attach: me.attach,
    };
  }
  if (process.env.MODELBUS_AS) return testIdentity(process.env.MODELBUS_AS);
  throw new Error("not inside a known host session; register, or pass --as <name> for testing");
}
