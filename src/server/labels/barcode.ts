// Doc 25 labels: in-house barcode encoders (no dependency). Each returns the module
// string — "1" bar, "0" space — without quiet zones; the page draws it as SVG rects.

// Code 128 bar/space widths per symbol value 0–105 (106 = stop, 13 modules).
const C128 = (
  "212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 221312 231212 112232 122132 122231 113222 " +
  "123122 123221 223211 221132 221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 212123 212321 " +
  "232121 111323 131123 131321 112313 132113 132311 211313 231113 231311 112133 112331 132131 113123 113321 133121 " +
  "313121 211331 231131 213113 213311 213131 311123 311321 331121 312113 312311 332111 314111 221411 431111 111224 " +
  "111422 121124 121421 141122 141221 112214 112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 " +
  "111242 121142 121241 114212 124112 124211 411212 421112 421211 212141 214121 412121 111143 111341 131141 114113 " +
  "114311 411113 411311 113141 114131 311141 411131 211412 211214 211232 2331112"
).split(" ");
export const CODE128_PATTERNS = C128;
const START_B = 104, START_C = 105, TO_C = 99, TO_B = 100, STOP = 106;

// Symbol values incl. start, check and stop. Set B, switching to C for digit runs
// worth it (≥ 4 at either end, ≥ 6 in the middle; an odd run leaves its first digit in B).
export function code128Values(text: string): number[] {
  if (!text || !/^[\x20-\x7e]+$/.test(text)) throw new Error("Code 128 needs printable ASCII");
  const out: number[] = [];
  let set: "B" | "C" | null = null;
  for (let i = 0; i < text.length; ) {
    let run = 0;
    while (/\d/.test(text[i + run] ?? "")) run++;
    const edge = i === 0 || i + run === text.length;
    if (run >= (edge ? 4 : 6) || (run === text.length && run % 2 === 0)) {
      if (run % 2) { // odd: first digit in B
        out.push(set === null ? START_B : TO_B, text.charCodeAt(i) - 32);
        set = "B"; i++; run--;
      }
      out.push(set === null ? START_C : TO_C);
      set = "C";
      for (const end = i + run; i < end; i += 2) out.push(Number(text.slice(i, i + 2)));
    } else {
      if (set !== "B") out.push(set === null ? START_B : TO_B);
      set = "B";
      out.push(text.charCodeAt(i) - 32);
      i++;
    }
  }
  const check = out.reduce((sum, v, k) => sum + v * Math.max(k, 1), 0) % 103;
  return [...out, check, STOP];
}

export function code128(text: string): string {
  return code128Values(text)
    .map((v) => [...C128[v]].map((w, k) => (k % 2 ? "0" : "1").repeat(Number(w))).join(""))
    .join("");
}

// EAN-13: L codes; R = complement of L; G = R reversed. Parity of digits 2–7 from digit 1.
const L = ["0001101", "0011001", "0010011", "0111101", "0100011", "0110001", "0101111", "0111011", "0110111", "0001011"];
const R = L.map((c) => [...c].map((b) => (b === "1" ? "0" : "1")).join(""));
const G = R.map((c) => [...c].reverse().join(""));
const PARITY = ["LLLLLL", "LLGLGG", "LLGGLG", "LLGGGL", "LGLLGG", "LGGLLG", "LGGGLL", "LGLGLG", "LGLGGL", "LGGLGL"];

export function ean13CheckDigit(first12: string): number {
  const sum = [...first12].reduce((s, d, k) => s + Number(d) * (k % 2 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10;
}

export const isEan13 = (v: string) => /^\d{13}$/.test(v) && ean13CheckDigit(v.slice(0, 12)) === Number(v[12]);

export function ean13(value: string): string {
  if (!isEan13(value)) throw new Error("EAN-13 needs 13 digits with a valid check digit");
  const d = [...value].map(Number);
  const left = d.slice(1, 7).map((n, k) => (PARITY[d[0]][k] === "L" ? L[n] : G[n])).join("");
  return `101${left}01010${d.slice(7).map((n) => R[n]).join("")}101`;
}
