/**
 * Text measured in terminal cells, not characters. `Bun.stringWidth` knows about
 * wide characters, emoji and combining marks; slicing by code unit does not.
 */

export const width = (s: string): number => Bun.stringWidth(s);

const ELLIPSIS = "…";

/** Cut `s` to at most `w` cells, ending in an ellipsis when something was cut. */
export function truncate(s: string, w: number): string {
  if (w <= 0) return "";
  if (width(s) <= w) return s;
  if (w === 1) return ELLIPSIS;
  let out = "";
  let used = 0;
  for (const ch of s) {
    const cw = width(ch);
    if (used + cw > w - 1) break;
    out += ch;
    used += cw;
  }
  return out + ELLIPSIS;
}

/** Exactly `w` cells: truncated or padded on the right. */
export function fit(s: string, w: number): string {
  const t = truncate(s, w);
  return t + " ".repeat(Math.max(0, w - width(t)));
}

/** Exactly `w` cells, text at the right edge. */
export function fitRight(s: string, w: number): string {
  const t = truncate(s, w);
  return " ".repeat(Math.max(0, w - width(t))) + t;
}

/** Elapsed time as one unit: "12s", "4m", "3h", "2d". */
export function age(sinceMs: number | undefined, nowMs: number): string {
  if (sinceMs === undefined) return "";
  const s = Math.max(0, Math.floor((nowMs - sinceMs) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** `~` for the home directory, so paths fit and nothing personal is on screen. */
export function shortenHome(path: string | undefined, home = process.env.HOME): string {
  if (!path) return "";
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

/** The first line of a body, for one-row previews. */
export const firstLine = (s: string): string => s.split("\n")[0] ?? "";

/** Local wall-clock time as HH:MM:SS. */
export function clock(ms: number): string {
  const d = new Date(ms);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}
