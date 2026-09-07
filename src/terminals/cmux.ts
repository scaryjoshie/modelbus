import { $ } from "bun";
import type { TerminalLocation } from "../types.ts";

const CMUX_BIN = "/Applications/cmux.app/Contents/Resources/bin/cmux";

/**
 * Map every terminal surface cmux knows about to its tty, by parsing `cmux tree --all`.
 * Returns an empty map if cmux is not installed or not running.
 *
 * Tree format (indentation with box-drawing chars):
 *   window window:1 [current]
 *   ├── workspace workspace:7 "REFACTOR" [selected]
 *   │   └── pane pane:24 [focused]
 *   │       ├── surface surface:112 [terminal] "migration" tty=ttys012
 */
export async function cmuxSurfacesByTty(): Promise<Map<string, TerminalLocation>> {
  const map = new Map<string, TerminalLocation>();
  let out: string;
  try {
    out = await $`${CMUX_BIN} tree --all`.quiet().text();
  } catch {
    return map;
  }
  let workspace = "";
  let workspaceTitle: string | undefined;
  let pane: string | undefined;
  for (const raw of out.split("\n")) {
    const line = raw.replace(/^[\s│├└─]+/, "");
    let m = line.match(/^workspace (workspace:\d+)(?: "([^"]*)")?/);
    if (m) {
      workspace = m[1] ?? "";
      workspaceTitle = m[2];
      pane = undefined;
      continue;
    }
    m = line.match(/^pane (pane:\d+)/);
    if (m) {
      pane = m[1];
      continue;
    }
    m = line.match(/^surface (surface:\d+) \[terminal\](?: "([^"]*)")?.*?tty=(\S+)/);
    if (m) {
      const [, surface, title, tty] = m;
      if (!surface || !tty) continue;
      map.set(tty, {
        multiplexer: "cmux",
        tty,
        workspace,
        workspaceTitle,
        pane,
        surface,
        surfaceTitle: title,
      });
    }
  }
  return map;
}
