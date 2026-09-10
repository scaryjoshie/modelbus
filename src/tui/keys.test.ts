import { describe, expect, test } from "bun:test";
import { keyId, parseKeys } from "./keys.ts";

const ids = (input: string | number[]) =>
  parseKeys(typeof input === "string" ? input : new Uint8Array(input)).map(keyId);

describe("parseKeys", () => {
  test("printable characters, one key each", () => {
    expect(ids("jk/?")).toEqual(["j", "k", "/", "?"]);
    expect(ids("é漢")).toEqual(["é", "漢"]);
    expect(ids("😀")).toEqual(["😀"]);
  });

  test("control bytes", () => {
    expect(ids([3])).toEqual(["ctrl+c"]);
    expect(ids([13])).toEqual(["enter"]);
    expect(ids([9])).toEqual(["tab"]);
    expect(ids([127])).toEqual(["backspace"]);
    expect(ids(" ")).toEqual(["space"]);
  });

  test("arrows, home, end, paging in both encodings", () => {
    expect(ids("\x1b[A\x1b[B\x1b[C\x1b[D")).toEqual(["up", "down", "right", "left"]);
    expect(ids("\x1bOA\x1bOH\x1bOF")).toEqual(["up", "home", "end"]);
    expect(ids("\x1b[H\x1b[F\x1b[1~\x1b[4~")).toEqual(["home", "end", "home", "end"]);
    expect(ids("\x1b[5~\x1b[6~\x1b[3~")).toEqual(["pageup", "pagedown", "delete"]);
  });

  test("function keys", () => {
    expect(ids("\x1bOP\x1b[15~\x1b[24~")).toEqual(["f1", "f5", "f12"]);
  });

  test("modifiers", () => {
    expect(ids("\x1b[1;5A")).toEqual(["ctrl+up"]);
    expect(ids("\x1b[1;2B")).toEqual(["shift+down"]);
    expect(ids("\x1b[Z")).toEqual(["shift+tab"]);
    expect(ids("\x1bx")).toEqual(["alt+x"]);
  });

  test("a lone escape is the Escape key, also before another key", () => {
    expect(ids("\x1b")).toEqual(["escape"]);
    expect(ids("\x1b\x1b")).toEqual(["escape", "escape"]);
    expect(ids("\x1b[")).toEqual(["escape"]);
  });

  test("unknown sequences are dropped, following keys survive", () => {
    expect(ids("\x1b[99~q")).toEqual(["q"]);
    expect(ids("\x1b[?1;2cq")).toEqual(["q"]);
  });

  test("several keys in one chunk", () => {
    expect(ids("j\x1b[Bq")).toEqual(["j", "down", "q"]);
  });
});
