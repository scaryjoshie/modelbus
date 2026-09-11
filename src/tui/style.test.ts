import { describe, expect, test } from "bun:test";
import {
  detectDepth,
  HOST_HUES,
  type HostStyle,
  hostStyle,
  hostStyleById,
  type Style,
  sgr,
} from "./style.ts";

const ROLES: Style[] = ["ok", "bad", "wait", "group", "dm", "accent"];
const HOSTS: HostStyle[] = ["host0", "host1", "host2", "host3", "host4", "host5"];
const ROSTER = [
  { id: "a1", host: "zephyr" },
  { id: "a2", host: "apex" },
  { id: "a3", host: "north-shell" },
  { id: "a4", host: "apex" },
];

describe("hostStyle", () => {
  test("each host on the roster gets its own hue, in sorted order, stably", () => {
    expect(hostStyle(ROSTER, "apex")).toBe("host0");
    expect(hostStyle(ROSTER, "north-shell")).toBe("host1");
    expect(hostStyle(ROSTER, "zephyr")).toBe("host2");
    expect(hostStyle(ROSTER, "zephyr")).toBe(hostStyle([...ROSTER].reverse(), "zephyr"));
  });

  test("a host absent from the roster takes the next hue; many hosts wrap", () => {
    expect(hostStyle(ROSTER, "elsewhere")).toBe("host3");
    const many = Array.from({ length: 8 }, (_, i) => ({ host: `h${i}` }));
    expect(hostStyle(many, "h6")).toBe("host0");
    expect(hostStyle([], "any")).toBe("host0");
    for (const h of ["apex", "elsewhere"]) expect(HOSTS).toContain(hostStyle(ROSTER, h));
  });

  test("by id: the roster's host, or plain for a stranger", () => {
    expect(hostStyleById(ROSTER, "a1")).toBe(hostStyle(ROSTER, "zephyr"));
    expect(hostStyleById(ROSTER, "a4")).toBe(hostStyle(ROSTER, "apex"));
    expect(hostStyleById(ROSTER, "gone")).toBe("plain");
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
