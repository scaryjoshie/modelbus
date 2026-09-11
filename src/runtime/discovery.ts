import type { Observation, Provider } from "./provider.ts";

export type DiscoveryResult =
  | { provider: string; status: "observed"; observations: Observation[] }
  | { provider: string; status: "failed"; detail: string };

/** Observe providers without registering agents, configuring hosts, or delivering. */
export async function discover(providers: readonly Provider[]): Promise<DiscoveryResult[]> {
  const results: DiscoveryResult[] = [];
  for (const provider of providers) {
    if (!provider.discovery) continue;
    try {
      results.push({
        provider: provider.name,
        status: "observed",
        observations: await provider.discovery.observe(),
      });
    } catch (e) {
      results.push({
        provider: provider.name,
        status: "failed",
        detail: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return results;
}
