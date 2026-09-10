import { describe, expect, test } from "bun:test";
import { openTerminal, RESIZE_DEBOUNCE_MS, type TerminalIo } from "./terminal.ts";

/** Fakes for the three things the terminal touches, recording everything. */
function fakeIo(opts: { tty?: boolean } = {}) {
  const writes: string[] = [];
  const errors: string[] = [];
  const raw: boolean[] = [];
  const exits: number[] = [];
  const flow: string[] = [];
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  let resizeHandler: (() => void) | undefined;
  let dataHandler: ((chunk: Uint8Array) => void) | undefined;
  const io: TerminalIo & { columns: number; rows: number } = {
    columns: 80,
    rows: 24,
    out: {
      write: (s) => writes.push(s),
      get columns() {
        return io.columns;
      },
      get rows() {
        return io.rows;
      },
      on: (_event, handler) => {
        resizeHandler = handler;
      },
    },
    inp: {
      isTTY: opts.tty ?? true,
      setRawMode: (b) => raw.push(b),
      resume: () => flow.push("resume"),
      pause: () => flow.push("pause"),
      on: (_event, handler) => {
        dataHandler = handler;
      },
    },
    proc: {
      on: (event, handler) => listeners.set(event, [...(listeners.get(event) ?? []), handler]),
      off: (event, handler) =>
        listeners.set(
          event,
          (listeners.get(event) ?? []).filter((h) => h !== handler),
        ),
      exit: (code) => {
        exits.push(code);
        // A real exit never returns; the sentinel keeps the fake honest about that.
        throw new Error(`exit ${code}`);
      },
    },
    error: (m) => errors.push(m),
  };
  const fire = (event: string, ...args: unknown[]) => {
    for (const h of listeners.get(event) ?? []) {
      try {
        h(...args);
      } catch (e) {
        if (!(e instanceof Error && e.message.startsWith("exit "))) throw e;
      }
    }
  };
  return {
    io,
    writes,
    errors,
    raw,
    exits,
    flow,
    listeners,
    fire,
    resize: () => resizeHandler?.(),
    data: (chunk: Uint8Array) => dataHandler?.(chunk),
  };
}

const SETUP = "\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H";
const TEARDOWN = "\x1b[0m\x1b[?25h\x1b[?1049l";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("openTerminal", () => {
  test("enters raw mode and the alternate screen, hides the cursor", () => {
    const f = fakeIo();
    openTerminal(f.io);
    expect(f.writes).toEqual([SETUP]);
    expect(f.raw).toEqual([true]);
    expect(f.flow).toEqual(["resume"]);
  });

  test("leaves raw mode alone when stdin is not a terminal", () => {
    const f = fakeIo({ tty: false });
    openTerminal(f.io).restore();
    expect(f.raw).toEqual([]);
  });

  test("restore is idempotent and nothing writes after it", () => {
    const f = fakeIo();
    const term = openTerminal(f.io);
    term.write("frame");
    term.restore();
    term.restore();
    term.write("late");
    expect(f.writes).toEqual([SETUP, "frame", TEARDOWN]);
    expect(f.raw).toEqual([true, false]);
    expect(f.flow).toEqual(["resume", "pause"]);
  });

  test("restore detaches every process handler it installed", () => {
    const f = fakeIo();
    openTerminal(f.io);
    const events = [
      "SIGINT",
      "SIGTERM",
      "SIGHUP",
      "uncaughtException",
      "unhandledRejection",
      "exit",
    ];
    for (const e of events) expect(f.listeners.get(e)).toHaveLength(1);
    f.fire("exit");
    for (const e of events) expect(f.listeners.get(e)).toHaveLength(0);
    expect(f.writes).toEqual([SETUP, TEARDOWN]);
  });

  test.each([
    ["SIGINT", 130],
    ["SIGTERM", 143],
    ["SIGHUP", 129],
  ])("%s restores, then exits %d", (signal, code) => {
    const f = fakeIo();
    openTerminal(f.io);
    f.fire(signal);
    expect(f.writes).toEqual([SETUP, TEARDOWN]);
    expect(f.exits).toEqual([code]);
  });

  test.each(["uncaughtException", "unhandledRejection"])(
    "%s restores first, then reports the error, then exits 1",
    (event) => {
      const f = fakeIo();
      const term = openTerminal(f.io);
      const order: string[] = [];
      f.io.error = (m) => {
        order.push(`error:${m.split("\n")[0]}`);
        order.push(`writes:${f.writes.length}`);
      };
      f.fire(event, new Error("boom"));
      expect(order).toEqual(["error:Error: boom", "writes:2"]);
      expect(f.writes[1]).toBe(TEARDOWN);
      expect(f.exits).toEqual([1]);
      term.write("late");
      expect(f.writes).toHaveLength(2);
    },
  );

  test("a non-Error rejection is reported as text", () => {
    const f = fakeIo();
    openTerminal(f.io);
    f.io.error = (m) => f.errors.push(m);
    f.fire("unhandledRejection", "nope");
    expect(f.errors).toEqual(["nope"]);
    expect(f.exits).toEqual([1]);
  });

  test("input stops reaching the handler after restore", () => {
    const f = fakeIo();
    const term = openTerminal(f.io);
    const seen: number[] = [];
    term.onInput((c) => seen.push(c.length));
    f.data(new Uint8Array([106]));
    term.restore();
    f.data(new Uint8Array([113]));
    expect(seen).toEqual([1]);
  });

  test("a burst of resizes becomes one call with the last size", async () => {
    const f = fakeIo();
    const term = openTerminal(f.io);
    const sizes: Array<{ cols: number; rows: number }> = [];
    term.onResize((s) => sizes.push(s));
    f.io.columns = 100;
    f.resize();
    f.io.columns = 120;
    f.resize();
    f.io.columns = 90;
    f.io.rows = 30;
    f.resize();
    expect(sizes).toEqual([]);
    await wait(RESIZE_DEBOUNCE_MS / 2);
    expect(sizes).toEqual([]);
    await wait(RESIZE_DEBOUNCE_MS);
    expect(sizes).toEqual([{ cols: 90, rows: 30 }]);
  });

  test("a resize pending at restore never fires", async () => {
    const f = fakeIo();
    const term = openTerminal(f.io);
    const sizes: unknown[] = [];
    term.onResize((s) => sizes.push(s));
    f.resize();
    term.restore();
    await wait(RESIZE_DEBOUNCE_MS * 2);
    expect(sizes).toEqual([]);
  });

  test("size falls back to 80 by 24 when the stream reports nothing", () => {
    const f = fakeIo();
    f.io.columns = 0;
    f.io.rows = 0;
    expect(openTerminal(f.io).size()).toEqual({ cols: 80, rows: 24 });
  });
});
