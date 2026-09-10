import { closeSync, existsSync, openSync, readSync, statSync, watch } from "node:fs";

/** Current size of a file, to capture *before* a delivery so no entry is missed. */
export function fileOffset(path: string): number {
  return existsSync(path) ? statSync(path).size : 0;
}

/** If the transcript does not exist yet, look for it this often. */
const EXISTS_POLL_MS = 1000;
/** Stop watching for the read mark after this long. */
const GIVE_UP_MS = 15 * 60 * 1000;

/**
 * Watch an append-only transcript for a line containing `marker` that `accept`s,
 * reading from `fromOffset` (capture it before delivering). Uses file change
 * events; polls only while the file does not exist yet. Calls `onFound` once.
 */
export function watchTranscript(opts: {
  path: string;
  marker: string;
  accept: (line: string) => boolean;
  onFound: () => void;
  fromOffset?: number;
  timeoutMs?: number;
}): () => void {
  let offset = opts.fromOffset ?? fileOffset(opts.path);
  let watcher: ReturnType<typeof watch> | undefined;
  let poll: ReturnType<typeof setTimeout> | undefined;
  const giveUp = setTimeout(() => stop(), opts.timeoutMs ?? GIVE_UP_MS);

  const stop = () => {
    clearTimeout(giveUp);
    if (poll) clearTimeout(poll);
    watcher?.close();
    watcher = undefined;
  };

  const check = () => {
    if (!existsSync(opts.path)) return;
    const size = statSync(opts.path).size;
    if (size <= offset) return;
    const fd = openSync(opts.path, "r");
    try {
      const buf = Buffer.alloc(size - offset);
      readSync(fd, buf, 0, buf.length, offset);
      offset = size;
      for (const line of buf.toString("utf8").split("\n")) {
        if (line.includes(opts.marker) && opts.accept(line)) {
          stop();
          opts.onFound();
          return;
        }
      }
    } finally {
      closeSync(fd);
    }
  };

  const start = () => {
    if (!existsSync(opts.path)) {
      poll = setTimeout(start, EXISTS_POLL_MS);
      return;
    }
    watcher = watch(opts.path, () => check());
    check();
  };
  start();
  return stop;
}
