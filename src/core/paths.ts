import { chmodSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Where modelbus keeps its state. MODELBUS_HOME points a client at another instance. */
export function modelbusHome(): string {
  return process.env.MODELBUS_HOME ?? join(homedir(), ".modelbus");
}

/**
 * Create the home if needed and keep it, and everything in it, readable by its
 * owner only (0700 / 0600). The database holds every message and the socket is
 * the door; same-user programs are trusted, other accounts are not.
 */
export function ensureHome(): string {
  const home = modelbusHome();
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  for (const name of readdirSync(home)) chmodSync(join(home, name), 0o600);
  return home;
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
