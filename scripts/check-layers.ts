#!/usr/bin/env bun
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Enforce the layering rule: core is what would exist with zero known hosts.
 *
 *   core      src/core/**            may import: nothing else in src
 *   helpers   src/util/**            may import: nothing else in src
 *   runtime   src/runtime/**         may import: core, util, runtime
 *   providers src/providers/**       may import: own folder, runtime contract, delivery, paths, util
 *   clients   cli, mcp, identity, client, ensure, render, daemon: anything
 *
 * Fails with a list of violations. Run as part of `bun run check`.
 */

const root = join(import.meta.dir, "..", "src");
const rules: Array<{ name: string; test: (f: string) => boolean; allow: (t: string) => boolean }> =
  [
    { name: "core", test: (f) => f.startsWith("core/"), allow: (t) => t.startsWith("core/") },
    { name: "util", test: (f) => f.startsWith("util/"), allow: (t) => t.startsWith("util/") },
    {
      name: "runtime",
      test: (f) => f.startsWith("runtime/"),
      allow: (t) => t.startsWith("core/") || t.startsWith("util/") || t.startsWith("runtime/"),
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
  const providerFolder =
    rel.startsWith("providers/") && rel !== "providers/index.ts"
      ? rel.split("/").slice(0, 2).join("/")
      : undefined;
  if (!rule && !providerFolder) continue;
  const src = readFileSync(file, "utf8");
  for (const m of src.matchAll(/from\s+"(\.[^"]+)"/g)) {
    const target = relative(root, join(file, "..", m[1] ?? ""));
    if (rule && !rule.allow(target)) violations.push(`${rel} (${rule.name}) imports ${target}`);
    if (
      providerFolder &&
      !(
        target.startsWith(`${providerFolder}/`) ||
        target.startsWith("util/") ||
        target === "runtime/provider.ts" ||
        target === "core/delivery.ts" ||
        target === "core/paths.ts"
      )
    )
      violations.push(`${rel} (provider) imports ${target}`);
  }
}
if (violations.length) {
  console.error(`layering violations:\n  ${violations.join("\n  ")}`);
  process.exit(1);
}
console.log("layers ok");
