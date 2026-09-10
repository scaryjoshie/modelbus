import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Secrets } from "./provider.ts";

/**
 * The daemon's secrets: one owner-only JSON file per provider under `dir`. Each
 * write replaces the whole file through a temp file and a rename, so a crash never
 * leaves a torn file. No encryption: programs running as the same user are trusted,
 * other accounts cannot read the directory. Nothing here touches core.
 */
export function fileSecrets(dir: string, host: string): Secrets {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${host}.json`);

  const read = (): Record<string, string> => {
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw e;
    }
    // A file that exists but does not parse is an error, not an empty store:
    // silently starting over would lose every secret in it.
    return Entries.parse(JSON.parse(raw));
  };
  const write = (entries: Record<string, string>): void => {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(entries), { mode: 0o600 });
    renameSync(tmp, path);
  };

  return {
    get: (name) => read()[name],
    set: (name, value) => write({ ...read(), [name]: value }),
    delete: (name) => {
      const entries = read();
      delete entries[name];
      write(entries);
    },
    list: () => Object.keys(read()),
  };
}

const Entries = z.record(z.string(), z.string());
