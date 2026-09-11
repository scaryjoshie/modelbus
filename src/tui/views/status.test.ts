import { describe, expect, test } from "bun:test";
import { Grid } from "../screen.ts";
import { type Agent, initialState, type State } from "../state.ts";
import { clock } from "../text.ts";
import { drawStatus } from "./status.ts";

const agent = (name: string, host = "h"): Agent => ({
  id: name,
  name,
  host,
  lastSeen: 0,
  purpose: null,
  reachable: true,
});

const COLS = 120;
const rect = { x: 0, y: 0, w: COLS, h: 1 };

const base = (extra: Partial<State> = {}): State => ({
  ...initialState({ cols: COLS, rows: 10 }, 0),
  agents: [agent("alpha"), agent("beta"), agent("gamma")],
  ...extra,
});

const draw = (state: State, w = COLS) => {
  const g = new Grid(w, 1);
  drawStatus(state, { ...rect, w }, g);
  return g;
};
const styleAt = (g: Grid, x: number) => g.cells[0]?.[x]?.style;

describe("drawStatus", () => {
  test("hints for the tab: key plain, label dim, two spaces between", () => {
    const g = draw(base());
    const text = g.text(0);
    expect(text.startsWith("tab switch tab  ↑/↓ move  f filter  c mark pending")).toBe(true);
    expect(styleAt(g, 0)).toBe("plain");
    expect(styleAt(g, 4)).toBe("dim");
    expect(styleAt(g, 16)).toBe("plain");
  });

  test("hints follow the tab: no marks or renames on the Chats tab", () => {
    const text = draw(base({ tab: "chats" })).text(0);
    expect(text).toContain("⏎ read messages");
    expect(text).not.toContain("rename");
    expect(text).not.toContain("pending");
  });

  test("when hints do not fit, the middle ones go and help and quit stay", () => {
    expect(draw(base(), 14).text(0).trimEnd()).toBe("? help  q quit");
    expect(draw(base(), 30).text(0).trimEnd()).toBe("tab switch tab  ? help  q quit");
    expect(draw(base(), 6).text(0).trimEnd()).toBe("? help");
  });

  test("marked agents show as an accent count before the clock", () => {
    const g = draw(base({ pending: ["alpha", "beta"], lastPollAt: 0 }));
    const text = g.text(0);
    expect(text.endsWith(`2 pending  ${clock(0)}`)).toBe(true);
    const at = text.indexOf("2 pending");
    expect(styleAt(g, at)).toBe("accent");
    expect(styleAt(g, at + "2 pending".length - 1)).toBe("accent");
    expect(styleAt(g, COLS - 1)).toBe("dim");
    // The hint words say "pending" too; it is the count that must be absent.
    expect(draw(base({ pending: ["alpha"], tab: "chats" })).text(0)).not.toMatch(/\d+ pending/);
    expect(draw(base()).text(0)).not.toMatch(/\d+ pending/);
  });

  test("the last good poll shows as a dim clock at the right edge", () => {
    const at = Date.UTC(2026, 8, 10, 12, 34, 56);
    const g = draw(base({ lastPollAt: at }));
    expect(g.text(0).endsWith(clock(at))).toBe(true);
    expect(styleAt(g, COLS - 1)).toBe("dim");
    expect(draw(base()).text(0).trimEnd().endsWith("q quit")).toBe(true);
  });

  test("the filter count lives in the tab bar, not here", () => {
    expect(draw(base({ filter: "et", lastPollAt: 0 })).text(0)).not.toContain(" of ");
    expect(draw(base({ filter: "et", lastPollAt: 0 })).text(0)).not.toContain("1/3");
  });

  test("a failed action replaces the hints in bad and keeps the right half", () => {
    const g = draw(base({ notice: 'name "beta" is taken', lastPollAt: 0 }));
    expect(g.text(0).startsWith('name "beta" is taken')).toBe(true);
    expect(styleAt(g, 0)).toBe("bad");
    expect(g.text(0)).not.toContain("quit");
    expect(g.text(0).endsWith(clock(0))).toBe(true);
  });

  test("a poll error replaces the hints in bad and keeps the socket path", () => {
    const error = "modelbus is not running (/tmp/mb/daemon.sock); start it with: modelbus start";
    const g = draw(base({ error, lastPollAt: 0 }));
    expect(g.text(0).startsWith(error)).toBe(true);
    expect(g.text(0)).toContain("/tmp/mb/daemon.sock");
    expect(g.text(0).endsWith(clock(0))).toBe(true);
    expect(styleAt(g, 0)).toBe("bad");
    expect(g.text(0)).not.toContain("quit");
  });

  test("a failed action wins over a standing poll error", () => {
    const g = draw(base({ error: "daemon gone", notice: "rename failed" }));
    expect(g.text(0).startsWith("rename failed")).toBe(true);
    expect(g.text(0)).not.toContain("daemon gone");
  });

  test("a long error is truncated short of the clock", () => {
    const g = draw(base({ error: "x".repeat(200), lastPollAt: 0 }), 40);
    const text = g.text(0);
    expect(text).toHaveLength(40);
    expect(text.endsWith(`  ${clock(0)}`)).toBe(true);
    expect(text).toContain("…");
  });

  test("a rect with no room draws nothing", () => {
    const g = new Grid(10, 1);
    drawStatus(base(), { x: 0, y: 0, w: 0, h: 1 }, g);
    expect(g.text(0).trim()).toBe("");
  });
});
