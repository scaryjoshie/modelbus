import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";

/** Current size of a file, to capture *before* a delivery so no entry is missed. */
export function fileOffset(path: string): number {
  return existsSync(path) ? statSync(path).size : 0;
}

/**
 * Poll an append-only transcript for a line containing `marker` that `accept`s.
 * Reads from `fromOffset` (capture it before delivering). Calls `onFound` once.
 */
export function watchTranscript(opts: {
  path: string;
  marker: string;
  accept: (line: string) => boolean;
  onFound: () => void;
  fromOffset?: number;
  intervalMs?: number;
  timeoutMs?: number;
}): () => void {
  const intervalMs = opts.intervalMs ?? 1000;
  const timeoutMs = opts.timeoutMs ?? 15 * 60 * 1000;
  let offset = opts.fromOffset ?? fileOffset(opts.path);
  const started = Date.now();
  const check = () => {
    if (Date.now() - started > timeoutMs) return stop();
    if (!existsSync(opts.path)) return;
    const size = statSync(opts.path).size;
    if (size <= offset) return;
    const fd = openSync(opts.path, "r");
    const buf = Buffer.alloc(size - offset);
    readSync(fd, buf, 0, buf.length, offset);
    closeSync(fd);
    offset = size;
    for (const line of buf.toString("utf8").split("\n")) {
      if (line.includes(opts.marker) && opts.accept(line)) {
        stop();
        opts.onFound();
        return;
      }
    }
  };
  const timer = setInterval(check, intervalMs);
  const stop = () => clearInterval(timer);
  check();
  return stop;
}
