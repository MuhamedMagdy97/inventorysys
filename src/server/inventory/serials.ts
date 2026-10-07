import type { SerialStatus, SerialUnit } from "@/generated/prisma/client";
import type { Ctx } from "@/server/core/ctx";
import { AppError } from "@/server/core/errors";
import type { Tx } from "@/server/db";
import type { Dec } from "./post";

// TR-04 / I-06: the caller names the exact units it moves. Each must be this variant's,
// at this position, in one of the expected states (and on the given transfer line).
// Locked FOR UPDATE so two documents can't move the same unit.
export async function takeSerials(
  tx: Tx,
  ctx: Ctx,
  p: {
    sku: string; variantId: string; warehouseId: string; batchId: string | null; qty: Dec; serials: string[] | undefined;
    status: SerialStatus[]; transferLineId?: string; field?: string;
  },
): Promise<SerialUnit[]> {
  const field = p.field ?? "serials";
  const list = (p.serials ?? []).map((x) => x.trim()).filter(Boolean);
  if (!p.qty.isInteger() || list.length !== p.qty.toNumber() || new Set(list).size !== list.length) {
    throw new AppError("validation_error", `${p.sku}: list exactly ${p.qty.toString()} distinct serial number(s) (TR-04)`, { field, sku: p.sku, expected: p.qty.toString(), got: list.length });
  }
  if (!list.length) return [];
  const ids = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM serial_unit
    WHERE company_id = ${ctx.companyId} AND variant_id = ${p.variantId} AND serial_no = ANY(${list}::text[]) AND status <> 'reversed'
    ORDER BY id FOR UPDATE`;
  const units = await tx.serialUnit.findMany({ where: { id: { in: ids.map((r) => r.id) } } });
  const bad = list.filter((n) => {
    const u = units.find((x) => x.serialNo === n);
    return !u || u.warehouseId !== p.warehouseId || u.batchId !== p.batchId || !p.status.includes(u.status)
      || (p.transferLineId !== undefined && u.transferLineId !== p.transferLineId);
  });
  if (bad.length) {
    throw new AppError("validation_error", `${p.sku}: serial(s) not available here: ${bad.join(", ")}`, { field, sku: p.sku, serials: bad });
  }
  return units;
}

// S-01 for new units (opening balance, count found): unique in the list and among live units
// (the partial unique index `serial_unit_live_key` is the backstop).
export async function assertSerialsFree(tx: Tx, ctx: Ctx, serials: string[]) {
  const taken = await tx.serialUnit.findMany({ where: { companyId: ctx.companyId, serialNo: { in: serials }, status: { not: "reversed" } }, select: { serialNo: true } });
  const dupes = [...new Set([...taken.map((t) => t.serialNo), ...serials.filter((n, i, a) => a.indexOf(n) !== i)])];
  if (dupes.length) throw new AppError("duplicate", `Serial number(s) already exist: ${dupes.join(", ")}`, { field: "serials", serials: dupes });
}

// Leg quantities per bin for a set of units.
export function perBin(units: SerialUnit[]): { binId: string; qty: number }[] {
  const m = new Map<string, number>();
  for (const u of units) m.set(u.binId ?? "", (m.get(u.binId ?? "") ?? 0) + 1);
  return [...m].map(([binId, qty]) => ({ binId, qty }));
}
