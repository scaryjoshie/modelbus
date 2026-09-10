import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { DaemonUnreachable, rpc } from "./client.ts";
import { cliPath, ensureHome, socketPath } from "./core/paths.ts";

/**
 * The daemon as a login service. macOS only for now: one launchd agent that
 * starts at login and is restarted if it dies. Nothing installs it as a side
 * effect; `modelbus start` is the user's explicit act, `modelbus stop` undoes it.
 */

const LABEL = "dev.modelbus.daemon";
/** How long to wait for a daemon we asked to exit. */
const EXIT_WAIT_MS = 5000;

const plistPath = () => join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const domain = () => `gui/${process.getuid?.() ?? 501}`;

function requireMac(): void {
  if (process.platform !== "darwin") {
    throw new Error("the login service is macOS-only for now; run `modelbus serve` in a terminal");
  }
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The agent definition: run the daemon from this checkout with the installer's PATH. */
function plist(): string {
  const home = ensureHome();
  const args = [process.execPath, cliPath(), "serve"];
  const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
  if (process.env.MODELBUS_HOME) env.MODELBUS_HOME = process.env.MODELBUS_HOME;
  const envXml = Object.entries(env)
    .map(([k, v]) => `    <key>${xml(k)}</key><string>${xml(v)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${xml(a)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(join(home, "daemon.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(join(home, "daemon.log"))}</string>
</dict>
</plist>
`;
}

async function loaded(): Promise<boolean> {
  return (await $`launchctl print ${domain()}/${LABEL}`.quiet().nothrow()).exitCode === 0;
}

/** Ask a daemon that is not ours to exit, and wait for it. */
async function stopStray(): Promise<string | undefined> {
  let pid: number;
  try {
    pid = (await rpc("ping", {})).pid;
  } catch (e) {
    if (e instanceof DaemonUnreachable) return undefined;
    throw e;
  }
  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + EXIT_WAIT_MS;
  while (Date.now() < deadline && existsSync(socketPath())) await Bun.sleep(100);
  return `stopped the daemon that was running outside the service (pid ${pid})`;
}

/** Install the login service if needed and start it now. */
export async function start(): Promise<string[]> {
  requireMac();
  if (await loaded()) return [`already running as login service ${LABEL}`];
  const out: string[] = [];
  const stray = await stopStray();
  if (stray) out.push(stray);
  mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
  writeFileSync(plistPath(), plist(), { mode: 0o600 });
  const r = await $`launchctl bootstrap ${domain()} ${plistPath()}`.quiet().nothrow();
  if (r.exitCode !== 0)
    throw new Error(`launchctl bootstrap failed: ${r.stderr.toString().trim()}`);
  out.push(`installed and started login service ${LABEL} (${plistPath()})`);
  return out;
}

/** Stop the daemon and remove the login service. */
export async function stop(): Promise<string[]> {
  requireMac();
  const out: string[] = [];
  if (await loaded()) {
    const r = await $`launchctl bootout ${domain()}/${LABEL}`.quiet().nothrow();
    if (r.exitCode !== 0)
      throw new Error(`launchctl bootout failed: ${r.stderr.toString().trim()}`);
    out.push(`stopped and removed login service ${LABEL}`);
  }
  if (existsSync(plistPath())) unlinkSync(plistPath());
  const stray = await stopStray();
  if (stray) out.push(stray);
  return out.length ? out : ["nothing was running"];
}

/** Restart the service's daemon, e.g. after a code change. */
export async function restart(): Promise<string[]> {
  requireMac();
  if (!(await loaded())) throw new Error("not installed as a login service; run `modelbus start`");
  const r = await $`launchctl kickstart -k ${domain()}/${LABEL}`.quiet().nothrow();
  if (r.exitCode !== 0)
    throw new Error(`launchctl kickstart failed: ${r.stderr.toString().trim()}`);
  return [`restarted ${LABEL}`];
}
