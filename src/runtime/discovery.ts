import type { Observation, Provider } from "./provider.ts";

export type DiscoveryResult =
  | { host: string; status: "observed"; observations: Observation[] }
  | { host: string; status: "failed"; detail: string };

/** Observe providers without registering agents, configuring hosts, or delivering. */
export async function discover(providers: readonly Provider[]): Promise<DiscoveryResult[]> {
  const results: DiscoveryResult[] = [];
  for (const provider of providers) {
    if (!provider.discovery) continue;
    try {
      results.push({
        host: provider.host,
        status: "observed",
        observations: await provider.discovery.observe(),
      });
    } catch (e) {
      results.push({
        host: provider.host,
        status: "failed",
        detail: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return results;
}
