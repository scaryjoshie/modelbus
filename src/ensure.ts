import { existsSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { DaemonUnreachable, rpc } from "./client.ts";
import { cliPath, modelbusHome, socketPath } from "./core/paths.ts";

/** Start the daemon detached if it isn't answering, then wait for it. */
export async function ensureDaemon(): Promise<void> {
  try {
    await rpc("ping");
    return;
  } catch (e) {
    if (!(e instanceof DaemonUnreachable)) throw e;
  }
  mkdirSync(modelbusHome(), { recursive: true });
  const log = openSync(join(modelbusHome(), "daemon.log"), "a");
  const child = Bun.spawn([process.execPath, cliPath(), "serve"], {
    stdio: ["ignore", log, log],
    env: process.env,
  });
  child.unref();
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (existsSync(socketPath())) {
      try {
        await rpc("ping");
        return;
      } catch {
        /* not ready yet */
      }
    }
    await Bun.sleep(100);
  }
  throw new Error("modelbus daemon did not start; see ~/.modelbus/daemon.log");
}
