import { describe, expect, it } from "vitest";
import { CODE128_PATTERNS, code128, code128Values, ean13, ean13CheckDigit, isEan13 } from "./barcode";

describe("Code 128", () => {
  it("pattern table: 106 distinct 11-module symbols + 13-module stop", () => {
    const sum = (p: string) => [...p].reduce((s, w) => s + Number(w), 0);
    expect(CODE128_PATTERNS).toHaveLength(107);
    expect(new Set(CODE128_PATTERNS).size).toBe(107);
    expect(CODE128_PATTERNS.slice(0, 106).every((p) => p.length === 6 && sum(p) === 11)).toBe(true);
    expect(sum(CODE128_PATTERNS[106])).toBe(13);
  });

  it("set B text with a short digit run stays in B (check 55)", () => {
    expect(code128Values("PJJ123C")).toEqual([104, 48, 42, 42, 17, 18, 19, 35, 55, 106]);
  });

  it("all-digit even length uses set C (check 44)", () => {
    expect(code128Values("123456")).toEqual([105, 12, 34, 56, 44, 106]);
  });

  it("switches B → C for a trailing digit run", () => {
    expect(code128Values("AB12345678")).toEqual([104, 33, 34, 99, 12, 34, 56, 78, 57, 106]);
  });

  it("odd leading digit run: first digit in B, rest in C", () => {
    expect(code128Values("12345")).toEqual([104, 17, 99, 23, 45, (104 + 17 + 99 * 2 + 23 * 3 + 45 * 4) % 103, 106]);
  });

  it("modules: starts with Start B bars, ends with stop + final bar", () => {
    const m = code128("PJJ123C");
    expect(m.length).toBe(9 * 11 + 13);
    expect(m.startsWith("11010010000")).toBe(true); // Start B 211214
    expect(m.endsWith("1100011101011")).toBe(true); // stop 2331112
  });

  it("rejects non-printable / non-ASCII", () => {
    expect(() => code128("é")).toThrow();
    expect(() => code128("")).toThrow();
  });
});

describe("EAN-13", () => {
  it("check digits", () => {
    expect(ean13CheckDigit("400638133393")).toBe(1);
    expect(ean13CheckDigit("590123412345")).toBe(7);
    expect(isEan13("4006381333931")).toBe(true);
    expect(isEan13("4006381333932")).toBe(false);
    expect(isEan13("400638133393")).toBe(false);
  });

  it("encodes guards and parity (first digit 4 → LGLLGG)", () => {
    const m = ean13("4006381333931");
    expect(m).toHaveLength(95);
    expect(m.slice(0, 3)).toBe("101");
    expect(m.slice(3, 10)).toBe("0001101"); // 0 in L
    expect(m.slice(10, 17)).toBe("0100111"); // 0 in G
    expect(m.slice(45, 50)).toBe("01010");
    expect(m.slice(50, 57)).toBe("1000010"); // 8th digit 3 in R
    expect(m.slice(-3)).toBe("101");
    expect(() => ean13("4006381333932")).toThrow();
  });
});
