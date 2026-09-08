import type { HostAdapter } from "../core/adapter.ts";
import type { Store } from "../core/store.ts";
import { AsideAdapter } from "./aside.ts";
import { ClaudeCodeAdapter } from "./claude-code.ts";
import { CodexAdapter } from "./codex.ts";
import { RegisteredAdapter } from "./registered.ts";

/** Every host adapter the daemon runs. Adding a host is adding a line here. */
export function allAdapters(store?: Store): HostAdapter[] {
  const list: HostAdapter[] = [new ClaudeCodeAdapter(), new CodexAdapter(), new AsideAdapter()];
  if (store) list.push(new RegisteredAdapter(store));
  return list;
}
