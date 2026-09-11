import { describe, expect, test } from "bun:test";
import {
  detectDepth,
  PROVIDER_HUES,
  type ProviderStyle,
  providerStyle,
  providerStyleById,
  type Style,
  sgr,
} from "./style.ts";

const ROLES: Style[] = ["ok", "bad", "wait", "group", "dm", "accent"];
const HOSTS: ProviderStyle[] = [
  "provider0",
  "provider1",
  "provider2",
  "provider3",
  "provider4",
  "provider5",
];
const ROSTER = [
  { id: "a1", provider: "zephyr" },
  { id: "a2", provider: "apex" },
  { id: "a3", provider: "north-shell" },
  { id: "a4", provider: "apex" },
];

describe("providerStyle", () => {
  test("each host on the roster gets its own hue, in sorted order, stably", () => {
    expect(providerStyle(ROSTER, "apex")).toBe("provider0");
    expect(providerStyle(ROSTER, "north-shell")).toBe("provider1");
    expect(providerStyle(ROSTER, "zephyr")).toBe("provider2");
    expect(providerStyle(ROSTER, "zephyr")).toBe(providerStyle([...ROSTER].reverse(), "zephyr"));
  });

  test("a host absent from the roster takes the next hue; many hosts wrap", () => {
    expect(providerStyle(ROSTER, "elsewhere")).toBe("provider3");
    const many = Array.from({ length: 8 }, (_, i) => ({ provider: `h${i}` }));
    expect(providerStyle(many, "h6")).toBe("provider0");
    expect(providerStyle([], "any")).toBe("provider0");
    for (const h of ["apex", "elsewhere"]) expect(HOSTS).toContain(providerStyle(ROSTER, h));
  });

  test("by id: the roster's provider, or plain for a stranger", () => {
    expect(providerStyleById(ROSTER, "a1")).toBe(providerStyle(ROSTER, "zephyr"));
    expect(providerStyleById(ROSTER, "a4")).toBe(providerStyle(ROSTER, "apex"));
    expect(providerStyleById(ROSTER, "gone")).toBe("plain");
  });
});

describe("sgr", () => {
  test("no two roles or hosts share a color at either depth", () => {
    for (const depth of ["16", "256"] as const) {
      const codes = [...ROLES, ...HOSTS].map((s) => sgr(s, depth));
      expect(new Set(codes).size).toBe(codes.length);
      for (const c of codes) expect(c).not.toBe("");
    }
  });

  test("nothing under NO_COLOR; hosts are the bright colors with 16", () => {
    expect(detectDepth({ NO_COLOR: "1", TERM: "xterm-256color" }, true)).toBe("none");
    for (const s of [...ROLES, ...HOSTS]) expect(sgr(s, "none")).toBe("");
    const bright = HOSTS.map((s) => sgr(s, "16").slice("\x1b[".length, -1));
    for (const code of bright) expect(["91", "92", "93", "94", "95", "96"]).toContain(code);
  });
});
