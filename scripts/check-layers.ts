#!/usr/bin/env bun
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Enforce the layering rule: core is what would exist with zero known hosts.
 *
 *   core      src/core/**            may import: nothing else in src
 *   helpers   src/util/**            may import: nothing else in src
 *   adapters  src/adapters/**        may import: core, util
 *   clients   cli, mcp, identity, client, ensure, render, daemon, tracker: anything
 *
 * Fails with a list of violations. Run as part of `bun run check`.
 */

const root = join(import.meta.dir, "..", "src");
const rules: Array<{ name: string; test: (f: string) => boolean; allow: (t: string) => boolean }> =
  [
    { name: "core", test: (f) => f.startsWith("core/"), allow: (t) => t.startsWith("core/") },
    { name: "util", test: (f) => f.startsWith("util/"), allow: (t) => t.startsWith("util/") },
    {
      name: "adapters",
      test: (f) => f.startsWith("adapters/"),
      allow: (t) => t.startsWith("core/") || t.startsWith("util/") || t.startsWith("adapters/"),
    },
  ];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory()
      ? files(p)
      : p.endsWith(".ts") && !p.endsWith(".test.ts")
        ? [p]
        : [];
  });
}

const violations: string[] = [];
for (const file of files(root)) {
  const rel = relative(root, file);
  const rule = rules.find((r) => r.test(rel));
  if (!rule) continue;
  const src = readFileSync(file, "utf8");
  for (const m of src.matchAll(/from\s+"(\.[^"]+)"/g)) {
    const target = relative(root, join(file, "..", m[1] ?? ""));
    if (!rule.allow(target)) violations.push(`${rel} (${rule.name}) imports ${target}`);
  }
}
if (violations.length) {
  console.error(`layering violations:\n  ${violations.join("\n  ")}`);
  process.exit(1);
}
console.log("layers ok");
