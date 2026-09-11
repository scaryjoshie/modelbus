import { width } from "../text.ts";

/**
 * The one place the TUI wraps text. Bodies are read in the chat and the detail
 * pane, not skimmed, so they break into lines instead of ending in an ellipsis.
 */

/**
 * Break `text` into lines of at most `w` cells: on newlines first, then between
 * words, then inside a word only when the word alone is wider than the line.
 * Widths are terminal cells, so a CJK character or an emoji counts as two and
 * is never split across lines.
 */
export function wrap(text: string, w: number): string[] {
  const cols = Math.max(1, w);
  return text.split("\n").flatMap((paragraph) => wrapParagraph(paragraph, cols));
}

function wrapParagraph(paragraph: string, cols: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const token of paragraph.match(/\s+|\S+/g) ?? []) {
    if (/^\s+$/.test(token)) {
      // Whitespace that does not fit is what the line break stands in for.
      if (width(line) + width(token) <= cols) line += token;
      continue;
    }
    for (const piece of breakWord(token, cols)) {
      if (width(line) + width(piece) <= cols) line += piece;
      // Only indentation so far: replacing it beats emitting a blank line.
      else if (line.trim() === "") line = piece;
      else {
        lines.push(line.trimEnd());
        line = piece;
      }
    }
  }
  lines.push(line.trimEnd());
  return lines;
}

/** A word wider than a line, cut into pieces that each fit; anything else as is. */
function breakWord(word: string, cols: number): string[] {
  if (width(word) <= cols) return [word];
  const pieces: string[] = [];
  let piece = "";
  let used = 0;
  for (const ch of word) {
    const cw = width(ch);
    if (used + cw > cols && piece !== "") {
      pieces.push(piece);
      piece = "";
      used = 0;
    }
    piece += ch;
    used += cw;
  }
  if (piece !== "") pieces.push(piece);
  return pieces;
}
