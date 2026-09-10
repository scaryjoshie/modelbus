/**
 * Style roles, one meaning each, and their terminal encoding. Views name a role;
 * only this file knows what a role looks like at a given color depth.
 *
 *   ok        reachable agent, delivered or read message
 *   bad       unreachable agent, failed message
 *   wait      message sent but not yet delivered
 *   selected  the cursor row: inverse, never a color
 *   title     the focused pane's title: bold
 *   dim       secondary fields such as age and directory
 *   plain     everything else
 */
export type Style = "plain" | "dim" | "title" | "selected" | "ok" | "bad" | "wait";

export type Depth = "none" | "16" | "256" | "truecolor";

/** Decide as supports-color does; `NO_COLOR` and a non-terminal win over everything but `FORCE_COLOR`. */
export function detectDepth(env: Record<string, string | undefined>, isTTY: boolean): Depth {
  const force = env.FORCE_COLOR;
  if (force !== undefined && force !== "") {
    if (force === "0" || force === "false") return "none";
    if (force === "3") return "truecolor";
    if (force === "2") return "256";
    return "16";
  }
  if ((env.NO_COLOR ?? "") !== "") return "none";
  if (!isTTY || env.TERM === "dumb") return "none";
  const colorterm = env.COLORTERM ?? "";
  if (colorterm === "truecolor" || colorterm === "24bit") return "truecolor";
  if ((env.TERM ?? "").endsWith("-256color")) return "256";
  return "16";
}

/** SGR parameters that turn a role on; `""` is the plain default. */
const SGR_16: Record<Style, string> = {
  plain: "",
  dim: "2",
  title: "1",
  selected: "7",
  ok: "32",
  bad: "31",
  wait: "33",
};

/** With 256 colors the three status hues can be softer than the basic eight. */
const SGR_256: Record<Style, string> = {
  ...SGR_16,
  ok: "38;5;71",
  bad: "38;5;167",
  wait: "38;5;179",
};

/** Escape sequence that starts `style`, or "" when nothing needs to change from plain. */
export function sgr(style: Style, depth: Depth): string {
  if (depth === "none") return "";
  const params = (depth === "16" ? SGR_16 : SGR_256)[style];
  return params ? `\x1b[${params}m` : "";
}

export const SGR_RESET = "\x1b[0m";
