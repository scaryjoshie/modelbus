import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileSecrets } from "./secrets.ts";

describe("secrets", () => {
  let dir: string;
  beforeEach(() => {
    dir = join(mkdtempSync(join(tmpdir(), "modelbus-secrets-")), "secrets");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("a provider sees only its own entries; they survive a new handle", () => {
    const claude = fileSecrets(dir, "claude-code");
    const codex = fileSecrets(dir, "codex");
    claude.set("s1", "tok-1");
    claude.set("s2", "tok-2");
    codex.set("s1", "other");
    expect(claude.get("s1")).toBe("tok-1");
    expect(codex.get("s1")).toBe("other");
    expect(claude.list().sort()).toEqual(["s1", "s2"]);
    expect(codex.list()).toEqual(["s1"]);

    claude.set("s1", "tok-1b");
    claude.delete("s2");
    const again = fileSecrets(dir, "claude-code"); // as after a daemon restart
    expect(again.get("s1")).toBe("tok-1b");
    expect(again.list()).toEqual(["s1"]);
    expect(codex.get("s1")).toBe("other");
  });

  test("files are owner-only", () => {
    fileSecrets(dir, "claude-code").set("s1", "tok");
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "claude-code.json")).mode & 0o777).toBe(0o600);
  });

  test("an empty store reads as empty; a corrupt file is an error, not a reset", () => {
    const s = fileSecrets(dir, "claude-code");
    expect(s.get("nope")).toBeUndefined();
    expect(s.list()).toEqual([]);
    Bun.write(join(dir, "claude-code.json"), "{not json");
    expect(() => fileSecrets(dir, "claude-code").list()).toThrow();
  });
});
