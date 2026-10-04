// FormData → domain input. Empty fields are "not given" (undefined) or, for clearable
// fields, null. Domain functions do the real validation.
export const str = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
};
export const clearable = (f: FormData, k: string) => str(f, k) ?? null;
export const bool = (f: FormData, k: string) => f.get(k) === "on";
export const int = (f: FormData, k: string) => {
  const s = str(f, k);
  return s === undefined ? undefined : Number(s);
};
export const version = (f: FormData) => Number(f.get("version"));

// "size=M, color=Red" → { size: "M", color: "Red" }
export const attributes = (f: FormData, k: string) => {
  const s = str(f, k);
  if (!s) return undefined;
  return Object.fromEntries(s.split(",").map((p) => p.split("=").map((x) => x.trim())).filter(([a, b]) => a && b));
};
