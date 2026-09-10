import type { Provider } from "../runtime/provider.ts";
import { AsideProvider } from "./aside/index.ts";
import { ClaudeCodeProvider } from "./claude-code/index.ts";
import { CodexProvider } from "./codex/index.ts";

/** Every host provider the daemon runs. Adding a host is adding a line here. */
export function allProviders(): Provider[] {
  return [new ClaudeCodeProvider(), new CodexProvider(), new AsideProvider()];
}
