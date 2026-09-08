import type { HostAdapter } from "../core/adapter.ts";
import { AsideAdapter } from "./aside.ts";
import { ClaudeCodeAdapter } from "./claude-code.ts";
import { CodexAdapter } from "./codex.ts";

/** Every host adapter the daemon runs. Adding a host is adding a line here. */
export function allAdapters(): HostAdapter[] {
  return [new ClaudeCodeAdapter(), new CodexAdapter(), new AsideAdapter()];
}
