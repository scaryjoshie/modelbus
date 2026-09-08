import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";

/**
 * Poll an append-only transcript file for a line that contains `marker` and
 * satisfies `accept`. Calls `onFound` once, then stops. Starts reading from the
 * current end of file. Shared by the Claude Code and Codex receipt watchers.
 */
export function watchTranscript(opts: {
  path: string;
  marker: string;
  accept: (line: string) => boolean;
  onFound: () => void;
  intervalMs?: number;
  timeoutMs?: number;
}): () => void {
  const intervalMs = opts.intervalMs ?? 1000;
  const timeoutMs = opts.timeoutMs ?? 15 * 60 * 1000;
  let offset = existsSync(opts.path) ? statSync(opts.path).size : 0;
  const started = Date.now();
  const timer = setInterval(() => {
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
  }, intervalMs);
  const stop = () => clearInterval(timer);
  return stop;
}
