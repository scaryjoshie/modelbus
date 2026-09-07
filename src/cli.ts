#!/usr/bin/env bun
import { scan } from "./scan.ts";
import type { LiveSession } from "./types.ts";

function age(ms?: number): string {
  if (!ms) return "";
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function shortCwd(cwd?: string): string {
  if (!cwd) return "";
  const home = process.env.HOME ?? "";
  return home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
}

function table(rows: string[][], header: string[]): string {
  const all = [header, ...rows];
  const widths = header.map((_, i) => Math.max(...all.map((r) => (r[i] ?? "").length)));
  const fmt = (r: string[]) => r.map((c, i) => (c ?? "").padEnd(widths[i] ?? 0)).join("  ");
  return [fmt(header), fmt(widths.map((w) => "-".repeat(w))), ...rows.map(fmt)].join("\n");
}

function render(sessions: LiveSession[]): string {
  const rows = sessions.map((s) => [
    s.host,
    s.name.length > 32 ? `${s.name.slice(0, 31)}…` : s.name,
    s.pid ? String(s.pid) : "",
    s.status ?? "",
    age(s.startedAt),
    shortCwd(s.cwd),
    s.terminal
      ? `${s.terminal.workspaceTitle ?? s.terminal.workspace} / ${s.terminal.surfaceTitle ?? s.terminal.surface}`
      : "",
    s.reach.join(","),
  ]);
  return table(rows, ["host", "name", "pid", "status", "age", "cwd", "terminal", "reach"]);
}

const [cmd = "scan", ...rest] = process.argv.slice(2);

switch (cmd) {
  case "scan": {
    const sessions = await scan();
    if (rest.includes("--json")) {
      console.log(JSON.stringify(sessions, null, 2));
    } else {
      console.log(render(sessions));
      console.log(`\n${sessions.length} live sessions`);
    }
    break;
  }
  default:
    console.error(`unknown command: ${cmd}\nusage: modelbus scan [--json]`);
    process.exit(1);
}
