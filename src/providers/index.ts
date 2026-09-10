import type { Provider, Secrets } from "../runtime/provider.ts";
import { AsideProvider } from "./aside/index.ts";
import { ClaudeCodeProvider } from "./claude-code/index.ts";
import { CodexProvider } from "./codex/index.ts";

/**
 * Every host provider. Adding a host is adding a line here. The daemon passes
 * `secrets` so providers can remember across restarts; clients that only need
 * setup plans or self-identification pass nothing.
 */
export function allProviders(deps: { secrets?: (host: string) => Secrets } = {}): Provider[] {
  return [new ClaudeCodeProvider(deps.secrets), new CodexProvider(), new AsideProvider()];
}
