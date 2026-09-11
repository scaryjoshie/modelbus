import type { Grid } from "../screen.ts";
import { providerStyleById, type Style } from "../style.ts";
import { width } from "../text.ts";

/**
 * A line of text in more than one style: a member list where every name has its
 * own color, a message header with a colored sender and a dim time. The chat
 * views build these and draw them clipped to a width, ending in an ellipsis
 * when something was cut, the way a single-style `truncate` does.
 */

export interface Span {
  text: string;
  style: Style;
}

export type Line = Span[];

export const SEPARATOR = ", ";
const ELLIPSIS = "…";

export const lineWidth = (line: Line): number => line.reduce((n, s) => n + width(s.text), 0);

/** At most `w` cells; when cut, the last visible span ends in an ellipsis in its own style. */
export function truncateLine(line: Line, w: number): Line {
  if (w <= 0) return [];
  if (lineWidth(line) <= w) return line;
  const out: Line = [];
  let left = w - width(ELLIPSIS);
  for (const span of line) {
    const sw = width(span.text);
    if (sw <= left) {
      out.push(span);
      left -= sw;
      continue;
    }
    out.push({ text: head(span.text, left) + ELLIPSIS, style: span.style });
    return out;
  }
  return out;
}

/** The longest prefix of `s` that fits in `cells`; a wide character never straddles the cut. */
function head(s: string, cells: number): string {
  let out = "";
  let used = 0;
  for (const ch of s) {
    const cw = width(ch);
    if (used + cw > cells) break;
    out += ch;
    used += cw;
  }
  return out;
}

/**
 * Draw `line` at a position, clipped to `maxWidth` with an ellipsis. `override`
 * paints every span in one style: the cursor row is inverse and nothing else.
 * Returns the cells used.
 */
export function putLine(
  grid: Grid,
  x: number,
  y: number,
  line: Line,
  maxWidth: number,
  override?: Style,
): number {
  let cx = x;
  for (const span of truncateLine(line, maxWidth)) {
    cx += grid.put(cx, y, span.text, override ?? span.style, x + maxWidth - cx);
  }
  return cx - x;
}

export interface Participant {
  id: string;
  name: string;
}

/** What `providerStyleById` needs of the roster; views pass `state.agents`. */
export type Roster = ReadonlyArray<{ id: string; provider: string }>;

/** Every member's name in its host's hue, a dim comma between them. */
export function memberLine(participants: Participant[], agents: Roster): Line {
  return participants.flatMap(
    (p, i): Line => [
      ...(i > 0 ? [{ text: SEPARATOR, style: "dim" as const }] : []),
      { text: p.name, style: providerStyleById(agents, p.id) },
    ],
  );
}

/**
 * The hue for a name the data carries without an id: the id of the `known`
 * agent of that name (a conversation's participants, or the roster itself),
 * then its host from the roster; plain when either lookup fails. Names are
 * unique on the bus, so a match is the agent.
 */
export function nameStyle(name: string, known: Participant[], agents: Roster): Style {
  const p = known.find((m) => m.name === name);
  return p ? providerStyleById(agents, p.id) : "plain";
}
