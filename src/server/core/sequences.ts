import type { Tx } from "@/server/db";

// Per-company document numbers (doc 22 `sequences`), allocated inside the caller's
// transaction: the row lock serialises concurrent callers; a rollback leaves a gap
// that is never reused (edge #38).
export async function nextNumber(tx: Tx, companyId: string, name: string, prefix: string, width = 4): Promise<string> {
  const [row] = await tx.$queryRaw<{ n: bigint }[]>`
    INSERT INTO sequences (company_id, name, next) VALUES (${companyId}, ${name}, 2)
    ON CONFLICT (company_id, name) DO UPDATE SET next = sequences.next + 1
    RETURNING next - 1 AS n`;
  return `${prefix}${String(row.n).padStart(width, "0")}`;
}
