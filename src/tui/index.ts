import { parseKeys } from "./keys.ts";
import { DEFAULT_POLL_INTERVAL_MS, startPoller } from "./poll.ts";
import { type Grid, render } from "./screen.ts";
import { initialState, type Msg, type State, update } from "./state.ts";
import { detectDepth } from "./style.ts";
import { isInteractive, openTerminal } from "./terminal.ts";
import { view } from "./view.ts";

/**
 * Wiring: terminal in, messages through `update`, frames out. One render per
 * frame at most, and only the rows that changed.
 */

/** Draw at most this often; 30 frames a second is what the TUI frameworks default to. */
const FRAME_MS = 33;
/** How often the ages and the "last poll" clock advance without new data. */
const CLOCK_TICK_MS = 1000;

export interface TuiOptions {
  pollIntervalMs?: number;
}

export async function runTui(opts: TuiOptions = {}): Promise<void> {
  if (!isInteractive()) {
    throw new Error("modelbus tui needs an interactive terminal; try: modelbus who");
  }
  const term = openTerminal();
  const depth = detectDepth(process.env, true);
  let state: State = initialState(term.size(), Date.now());
  let shown: Grid | undefined;
  let frame: ReturnType<typeof setTimeout> | undefined;

  const draw = () => {
    frame = undefined;
    const next = view(state);
    term.write(render(shown, next, depth));
    shown = next;
  };
  const dispatch = (msg: Msg) => {
    state = update(state, msg);
    if (state.quit) return finish();
    if (frame === undefined) frame = setTimeout(draw, FRAME_MS);
  };

  const poller = startPoller({
    intervalMs: opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    dispatch,
  });
  const clock = setInterval(() => dispatch({ type: "tick", now: Date.now() }), CLOCK_TICK_MS);

  let done: () => void = () => undefined;
  const finished = new Promise<void>((resolve) => {
    done = resolve;
  });
  function finish() {
    poller.stop();
    clearInterval(clock);
    if (frame !== undefined) clearTimeout(frame);
    term.restore();
    done();
  }

  term.onInput((chunk) => {
    for (const key of parseKeys(chunk)) dispatch({ type: "key", key });
  });
  term.onResize((size) => {
    // A resized terminal has repainted itself; the next frame must be a full one.
    shown = undefined;
    dispatch({ type: "resize", size });
  });
  draw();
  await finished;
}
