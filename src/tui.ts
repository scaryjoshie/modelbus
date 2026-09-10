import { rpc } from "./client.ts";

/**
 * A temporary terminal view: the roster and the latest messages, redrawn every
 * couple of seconds. A UI may poll; models do not. Nothing else depends on this
 * file, and it will be replaced by a real UI.
 */

const REFRESH_MS = 2000;
const LOG_ROWS = 12;

const age = (ms: number) => {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`;
};
const home = process.env.HOME ?? "";
const shortCwd = (cwd?: string) =>
  cwd && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : (cwd ?? "");
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n));

function table(header: string[], rows: string[][], widths: number[]): string[] {
  const line = (r: string[]) => r.map((c, i) => clip(c, widths[i] ?? 10)).join("  ");
  return [line(header), widths.map((w) => "-".repeat(w)).join("  "), ...rows.map(line)];
}

async function frame(): Promise<string> {
  const [who, log] = await Promise.all([rpc("who", {}), rpc("log", {})]);
  const agents = table(
    ["name", "host", "delivery", "status", "cwd", "seen"],
    who.agents.map((a) => [
      a.name,
      a.host,
      a.reachable ? (a.note ?? "ok") : `no: ${a.note ?? "?"}`,
      a.status ?? "",
      shortCwd(a.cwd),
      age(a.lastSeen),
    ]),
    [32, 11, 24, 11, 30, 5],
  );
  const recent = log.rows.slice(-LOG_ROWS);
  const messages = table(
    ["id", "from", "to", "status", "body"],
    recent.map((r) => [r.id, r.fromName, r.toName, r.status, r.body.split("\n")[0] ?? ""]),
    [7, 22, 22, 9, 50],
  );
  return [
    `modelbus  ${new Date().toLocaleTimeString()}  ${who.agents.length} agents  (q to quit)`,
    "",
    ...agents,
    "",
    `latest messages (${log.rows.length} total)`,
    ...messages,
  ].join("\n");
}

export async function runTui(): Promise<void> {
  const draw = async () => {
    let body: string;
    try {
      body = await frame();
    } catch (e) {
      body = e instanceof Error ? e.message : String(e);
    }
    process.stdout.write(`\x1b[2J\x1b[H${body}\n`);
  };
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  process.stdin.on("data", (k) => {
    if (k.toString() === "q" || k[0] === 3) {
      process.stdout.write("\x1b[2J\x1b[H");
      process.exit(0);
    }
  });
  await draw();
  setInterval(draw, REFRESH_MS);
}
