import { homedir } from "node:os";
import { join } from "node:path";

/** Where modelbus keeps its state. MODELBUS_HOME points a client at another instance. */
export function modelbusHome(): string {
  return process.env.MODELBUS_HOME ?? join(homedir(), ".modelbus");
}

export function socketPath(): string {
  return join(modelbusHome(), "daemon.sock");
}

export function dbPath(): string {
  return join(modelbusHome(), "modelbus.db");
}

/** Path of the CLI entry, for spawning ourselves and for host configs. */
export function cliPath(): string {
  return join(import.meta.dir, "..", "cli.ts");
}

/** Where generated migrations live (repo-relative; a compiled binary embeds them later). */
export function migrationsDir(): string {
  return join(import.meta.dir, "..", "..", "drizzle");
}
