import { existsSync, openSync } from "node:fs";
import { join } from "node:path";
import { DaemonUnreachable, rpc } from "./client.ts";
import { cliPath, ensureHome, socketPath } from "./core/paths.ts";

const START_TIMEOUT_MS = 5000;
const POLL_MS = 100;

/** Start the daemon detached if it isn't answering, then wait for it. */
export async function ensureDaemon(): Promise<void> {
  try {
    await rpc("ping", {});
    return;
  } catch (e) {
    if (!(e instanceof DaemonUnreachable)) throw e;
  }
  const log = openSync(join(ensureHome(), "daemon.log"), "a", 0o600);
  const child = Bun.spawn([process.execPath, cliPath(), "serve"], {
    stdio: ["ignore", log, log],
    env: process.env,
  });
  child.unref();
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (existsSync(socketPath())) {
      try {
        await rpc("ping", {});
        return;
      } catch {
        /* not ready yet */
      }
    }
    await Bun.sleep(POLL_MS);
  }
  throw new Error("modelbus daemon did not start; see ~/.modelbus/daemon.log");
}
