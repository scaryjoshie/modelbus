import type { Size } from "./layout.ts";

/**
 * The terminal itself: raw mode, the alternate screen, the cursor, resize, and
 * one idempotent restore that every exit path reaches. Nothing else in the TUI
 * writes to stdout, and after restore nothing writes at all.
 */

const ALT_SCREEN_ON = "\x1b[?1049h";
const ALT_SCREEN_OFF = "\x1b[?1049l";
const CURSOR_HIDE = "\x1b[?25l";
const CURSOR_SHOW = "\x1b[?25h";
const CLEAR = "\x1b[2J\x1b[H";
const SGR_RESET = "\x1b[0m";

/** A burst of resize events becomes one redraw; OpenTUI waits the same. */
export const RESIZE_DEBOUNCE_MS = 100;
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
type Signal = (typeof SIGNALS)[number];
/** Exit codes the shell convention gives a process killed by a signal: 128 + number. */
const SIGNAL_EXIT_CODES: Record<Signal, number> = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };
/** Something threw past every handler: the screen is restored first, then this. */
const CRASH_EXIT_CODE = 1;
const DEFAULT_SIZE: Size = { cols: 80, rows: 24 };

export interface Terminal {
  size(): Size;
  write(bytes: string): void;
  onInput(handler: (chunk: Uint8Array) => void): void;
  onResize(handler: (size: Size) => void): void;
  /** Leave the terminal as we found it. Safe to call more than once. */
  restore(): void;
}

/** The slice of stdin, stdout and process the terminal touches; tests pass fakes. */
export interface TerminalIo {
  out: {
    write(bytes: string): unknown;
    columns?: number;
    rows?: number;
    on(event: "resize", handler: () => void): unknown;
  };
  inp: {
    isTTY?: boolean;
    setRawMode?(raw: boolean): unknown;
    resume(): unknown;
    pause(): unknown;
    on(event: "data", handler: (chunk: Uint8Array) => void): unknown;
  };
  proc: {
    on(event: string, handler: (...args: unknown[]) => void): unknown;
    off(event: string, handler: (...args: unknown[]) => void): unknown;
    exit(code: number): never;
  };
  /** Where a crash is reported after the screen is back. */
  error(message: string): void;
}

const processIo = (): TerminalIo => ({
  out: process.stdout,
  inp: process.stdin,
  proc: process,
  error: (message) => console.error(message),
});

/** True when a full-screen view can work here at all. */
export function isInteractive(): boolean {
  return (
    process.stdout.isTTY === true && process.stdin.isTTY === true && process.env.TERM !== "dumb"
  );
}

export function openTerminal(io: TerminalIo = processIo()): Terminal {
  const { out, inp, proc } = io;
  let restored = false;
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;

  // In raw mode Ctrl+C is a byte, not a signal, so these cover kill(1) and hangups;
  // the key handler covers the keyboard. Nothing catches SIGKILL.
  const onSignal = new Map<Signal, () => void>(
    SIGNALS.map((s) => [
      s,
      () => {
        restore();
        proc.exit(SIGNAL_EXIT_CODES[s]);
      },
    ]),
  );
  const onCrash = (e: unknown) => {
    restore();
    io.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
    proc.exit(CRASH_EXIT_CODE);
  };
  const onExit = () => restore();

  const restore = () => {
    if (restored) return;
    restored = true;
    if (resizeTimer !== undefined) clearTimeout(resizeTimer);
    // After a hangup the terminal may be gone; a failed write must not stop the
    // rest of the cleanup or turn a signal exit into a crash.
    try {
      out.write(`${SGR_RESET}${CURSOR_SHOW}${ALT_SCREEN_OFF}`);
    } catch {}
    if (inp.isTTY) inp.setRawMode?.(false);
    inp.pause();
    // Our job is done; let later errors and signals behave as they normally would.
    for (const [s, h] of onSignal) proc.off(s, h);
    proc.off("uncaughtException", onCrash);
    proc.off("unhandledRejection", onCrash);
    proc.off("exit", onExit);
  };

  if (inp.isTTY) inp.setRawMode?.(true);
  inp.resume();
  out.write(`${ALT_SCREEN_ON}${CURSOR_HIDE}${CLEAR}`);
  for (const [s, h] of onSignal) proc.on(s, h);
  proc.on("uncaughtException", onCrash);
  proc.on("unhandledRejection", onCrash);
  proc.on("exit", onExit);

  const size = (): Size => ({
    cols: out.columns || DEFAULT_SIZE.cols,
    rows: out.rows || DEFAULT_SIZE.rows,
  });
  return {
    size,
    write: (bytes) => {
      if (!restored) out.write(bytes);
    },
    onInput: (handler) =>
      inp.on("data", (chunk) => {
        if (!restored) handler(chunk);
      }),
    onResize: (handler) =>
      out.on("resize", () => {
        // The last event in a burst wins; the size is read when the timer fires.
        if (resizeTimer !== undefined) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          resizeTimer = undefined;
          if (!restored) handler(size());
        }, RESIZE_DEBOUNCE_MS);
      }),
    restore,
  };
}
