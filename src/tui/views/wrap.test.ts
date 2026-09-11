import { describe, expect, test } from "bun:test";
import { wrap } from "./wrap.ts";

describe("wrap", () => {
  test("breaks between words and keeps newlines", () => {
    expect(wrap("the quick brown fox", 9)).toEqual(["the quick", "brown fox"]);
    expect(wrap("one\ntwo three", 20)).toEqual(["one", "two three"]);
    expect(wrap("a\n\nb", 5)).toEqual(["a", "", "b"]);
    expect(wrap("", 5)).toEqual([""]);
  });

  test("a word wider than the line is cut, other words are not", () => {
    expect(wrap("abcdefghij kl", 4)).toEqual(["abcd", "efgh", "ij", "kl"]);
    expect(wrap("ab cdefgh", 4)).toEqual(["ab", "cdef", "gh"]);
  });

  test("wide characters count as two cells and never straddle a line", () => {
    expect(Bun.stringWidth("漢")).toBe(2);
    expect(wrap("漢字漢字漢", 4)).toEqual(["漢字", "漢字", "漢"]);
    expect(wrap("漢字漢", 3)).toEqual(["漢", "字", "漢"]);
    expect(wrap("🙂🙂🙂", 4)).toEqual(["🙂🙂", "🙂"]);
    expect(wrap("ok 🙂🙂", 5)).toEqual(["ok", "🙂🙂"]);
    expect(wrap("ok 🙂 🙂", 5)).toEqual(["ok 🙂", "🙂"]);
  });

  test("leading indentation survives; a width under one still makes progress", () => {
    expect(wrap("  code", 10)).toEqual(["  code"]);
    expect(wrap("漢", 0)).toEqual(["漢"]);
    expect(wrap("abc", -3)).toEqual(["a", "b", "c"]);
  });

  test("trailing spaces are dropped from every line", () => {
    expect(wrap("a b ", 3)).toEqual(["a b"]);
    expect(wrap("ab   cd", 3)).toEqual(["ab", "cd"]);
  });
});
