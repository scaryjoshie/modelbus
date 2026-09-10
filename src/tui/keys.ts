/**
 * Bytes from a raw-mode terminal to key events. The only escape-sequence parser
 * in the TUI; everything else sees `Key`.
 */

export interface Key {
  /** A printable character, or a name from `KeyName`. */
  name: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

export type KeyName =
  | "enter"
  | "escape"
  | "backspace"
  | "tab"
  | "space"
  | "up"
  | "down"
  | "left"
  | "right"
  | "home"
  | "end"
  | "pageup"
  | "pagedown"
  | "insert"
  | "delete"
  | "f1"
  | "f2"
  | "f3"
  | "f4"
  | "f5"
  | "f6"
  | "f7"
  | "f8"
  | "f9"
  | "f10"
  | "f11"
  | "f12";

const ESC = "\x1b";

/** Final byte of `CSI <params> <final>` and of `SS3 <final>` to a key name. */
const FINALS: Record<string, KeyName> = {
  A: "up",
  B: "down",
  C: "right",
  D: "left",
  H: "home",
  F: "end",
  P: "f1",
  Q: "f2",
  R: "f3",
  S: "f4",
  Z: "tab",
};

/** The number before `~` in `CSI <n> ~` to a key name. */
const TILDES: Record<string, KeyName> = {
  "1": "home",
  "2": "insert",
  "3": "delete",
  "4": "end",
  "5": "pageup",
  "6": "pagedown",
  "7": "home",
  "8": "end",
  "11": "f1",
  "12": "f2",
  "13": "f3",
  "14": "f4",
  "15": "f5",
  "17": "f6",
  "18": "f7",
  "19": "f8",
  "20": "f9",
  "21": "f10",
  "23": "f11",
  "24": "f12",
};

const key = (name: string, mods: Partial<Omit<Key, "name">> = {}): Key => ({
  name,
  ctrl: false,
  alt: false,
  shift: false,
  ...mods,
});

/** xterm encodes modifiers as 1 + bits: 1 shift, 2 alt, 4 ctrl. */
function modifiers(param: string | undefined): Pick<Key, "ctrl" | "alt" | "shift"> {
  const bits = (Number(param ?? "1") || 1) - 1;
  return { shift: (bits & 1) !== 0, alt: (bits & 2) !== 0, ctrl: (bits & 4) !== 0 };
}

/** One control sequence starting at `i` (just after ESC [ or ESC O), or undefined. */
function sequence(s: string, i: number, ss3: boolean): { key?: Key; end: number } | undefined {
  let j = i;
  while (j < s.length && s.charCodeAt(j) >= 0x30 && s.charCodeAt(j) <= 0x3f) j++;
  if (j >= s.length) return undefined;
  const params = s.slice(i, j).split(";");
  const final = s[j] ?? "";
  const end = j + 1;
  if (final === "~" && !ss3) {
    const name = TILDES[params[0] ?? ""];
    return name ? { key: key(name, modifiers(params[1])), end } : { end };
  }
  const name = FINALS[final];
  if (!name) return { end };
  // `CSI Z` is shift-tab; other finals carry their modifier in the second parameter.
  const mods = final === "Z" ? { shift: true } : modifiers(params[1]);
  return { key: key(name, mods), end };
}

function control(code: number): Key {
  if (code === 13 || code === 10) return key("enter");
  if (code === 9) return key("tab");
  if (code === 127 || code === 8) return key("backspace");
  if (code === 0) return key("space", { ctrl: true });
  return key(String.fromCharCode(code + 96), { ctrl: true });
}

/** Decode one chunk of input. A lone ESC at the end of a chunk is the Escape key. */
export function parseKeys(chunk: Uint8Array | string): Key[] {
  const s = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
  const keys: Key[] = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i] ?? "";
    if (ch !== ESC) {
      const code = s.codePointAt(i) ?? 0;
      if (code < 32 || code === 127) keys.push(control(code));
      else if (ch === " ") keys.push(key("space"));
      else keys.push(key(String.fromCodePoint(code)));
      i += code > 0xffff ? 2 : 1;
      continue;
    }
    const next = s[i + 1];
    if (next === undefined) {
      keys.push(key("escape"));
      i += 1;
    } else if (next === "[" || next === "O") {
      const seq = sequence(s, i + 2, next === "O");
      if (seq === undefined) {
        // A sequence cut off by the end of the chunk: read it as Escape.
        keys.push(key("escape"));
        i = s.length;
      } else {
        if (seq.key) keys.push(seq.key);
        i = seq.end;
      }
    } else if (next === ESC) {
      keys.push(key("escape"));
      i += 1;
    } else {
      // ESC followed by a plain key is Alt plus that key.
      const [inner] = parseKeys(s.slice(i + 1, i + 2));
      if (inner) keys.push({ ...inner, alt: true });
      i += 2;
    }
  }
  return keys;
}

/** The canonical spelling a binding table uses: "ctrl+c", "shift+tab", "j", "?". */
export function keyId(k: Key): string {
  const parts: string[] = [];
  if (k.ctrl) parts.push("ctrl");
  if (k.alt) parts.push("alt");
  if (k.shift) parts.push("shift");
  parts.push(k.name);
  return parts.join("+");
}
