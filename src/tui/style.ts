/**
 * Style roles, one meaning each, and their terminal encoding. Views name a role;
 * only this file knows what a role looks like at a given color depth.
 *
 *   ok        reachable agent, delivered or read message
 *   bad       unreachable agent, failed message, an error in the status row
 *   wait      message sent but not yet delivered
 *   group     a group's #name, wherever it appears
 *   dm        the "dm" label of a pair, wherever it appears
 *   accent    pending marks and their count; a non-zero unread count
 *   hostN     an agent's name and its host tag: one hue per host, by `hostStyle`
 *   selected  the cursor row: inverse, never a color
 *   title     the active tab, the pane that has the arrows: bold
 *   dim       secondary fields: ages, times, inactive tabs, zero counts, labels
 *   plain     everything else, and a name whose host is not known
 */
export type Style =
  | "plain"
  | "dim"
  | "title"
  | "selected"
  | "ok"
  | "bad"
  | "wait"
  | "group"
  | "dm"
  | "accent"
  | HostStyle;

/** How many hues hosts cycle through; the known hosts each get their own. */
export const HOST_HUES = 6;

export type HostStyle = `host${0 | 1 | 2 | 3 | 4 | 5}`;

const HOST_STYLES: readonly HostStyle[] = ["host0", "host1", "host2", "host3", "host4", "host5"];

/**
 * The hue for a host: the distinct hosts on the roster, sorted, take the hues in
 * order, so up to six hosts are all distinct and the same host is the same hue
 * everywhere. No host is named here (only providers name hosts); the host tag
 * drawn beside each name is the legend. A host absent from the roster, such as
 * the sender of an old message, takes the hue after the last.
 */
export function hostStyle(roster: ReadonlyArray<{ host: string }>, host: string): HostStyle {
  const hosts = [...new Set(roster.map((a) => a.host))].sort();
  const index = hosts.indexOf(host);
  return HOST_STYLES[(index >= 0 ? index : hosts.length) % HOST_HUES] ?? "host0";
}

/**
 * The hue for an agent known only by id: its host from the roster, else plain.
 * Views pass `state.agents`; this file stays free of the state type.
 */
export function hostStyleById(
  agents: ReadonlyArray<{ id: string; host: string }>,
  id: string,
): Style {
  const agent = agents.find((a) => a.id === id);
  return agent ? hostStyle(agents, agent.host) : "plain";
}

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

/**
 * SGR parameters that turn a role on; `""` is the plain default. With 16 colors
 * the roles take the standard colors and the hosts the six bright ones, so no
 * two roles share a color.
 */
const SGR_16: Record<Style, string> = {
  plain: "",
  dim: "2",
  title: "1",
  selected: "7",
  ok: "32",
  bad: "31",
  wait: "33",
  group: "34",
  dm: "36",
  accent: "35",
  host0: "94",
  host1: "95",
  host2: "93",
  host3: "96",
  host4: "92",
  host5: "91",
};

/**
 * With 256 colors the roles can be softer and the hosts vivid: roles in muted
 * green, red, gold, violet, teal and orange; hosts in saturated blue, pink,
 * amber, cyan, green and purple, all of middling brightness so they read on
 * dark and light backgrounds alike.
 */
const SGR_256: Record<Style, string> = {
  ...SGR_16,
  ok: "38;5;71",
  bad: "38;5;167",
  wait: "38;5;179",
  group: "38;5;141",
  dm: "38;5;73",
  accent: "38;5;208",
  host0: "38;5;75",
  host1: "38;5;205",
  host2: "38;5;214",
  host3: "38;5;44",
  host4: "38;5;112",
  host5: "38;5;135",
};

/** Escape sequence that starts `style`, or "" when nothing needs to change from plain. */
export function sgr(style: Style, depth: Depth): string {
  if (depth === "none") return "";
  const params = (depth === "16" ? SGR_16 : SGR_256)[style];
  return params ? `\x1b[${params}m` : "";
}

export const SGR_RESET = "\x1b[0m";
