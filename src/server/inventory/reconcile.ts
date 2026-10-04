import { authorize, type Ctx } from "@/server/core/ctx";
import { db } from "@/server/db";

export type Drift = { check: string; key: Record<string, unknown>; expected: string; actual: string };

type Row = {
  check: string;
  variant_id: string;
  warehouse_id: string;
  bin_id?: string | null;
  batch_id: string | null;
  expected: string;
  actual: string;
};

// Replays the ledger and compares it with the cached state (doc 07 §4). Read-only,
// inside one REPEATABLE READ snapshot so concurrent postings can't show as drift.
// Empty result = clean.
export async function reconcile(ctx: Ctx): Promise<Drift[]> {
  authorize(ctx, "inventory.view");
  const c = ctx.companyId;
  return db.$transaction(
    async (tx) => {
      const rows: Row[] = [
        // 1. Physical buckets per bin row = SUM of movement deltas.
        ...(await tx.$queryRaw<Row[]>`
          WITH m AS (
            SELECT variant_id, warehouse_id, bin_id, batch_id,
                   SUM(d_on_hand) oh, SUM(d_blocked) bl, SUM(d_damaged) dm, SUM(d_expired) ex
            FROM inventory_movement WHERE company_id = ${c} AND bin_id IS NOT NULL GROUP BY 1, 2, 3, 4),
          s AS (SELECT * FROM stock_balance WHERE company_id = ${c})
          SELECT 'balance' AS "check",
                 COALESCE(s.variant_id, m.variant_id) variant_id, COALESCE(s.warehouse_id, m.warehouse_id) warehouse_id,
                 COALESCE(s.bin_id, m.bin_id) bin_id, COALESCE(s.batch_id, m.batch_id) batch_id,
                 concat_ws('/', trim_scale(COALESCE(m.oh, 0)), trim_scale(COALESCE(m.bl, 0)), trim_scale(COALESCE(m.dm, 0)), trim_scale(COALESCE(m.ex, 0))) expected,
                 concat_ws('/', trim_scale(COALESCE(s.on_hand, 0)), trim_scale(COALESCE(s.blocked, 0)), trim_scale(COALESCE(s.damaged, 0)), trim_scale(COALESCE(s.expired, 0))) actual
          FROM s FULL JOIN m ON s.variant_id = m.variant_id AND s.warehouse_id = m.warehouse_id
            AND s.bin_id = m.bin_id AND COALESCE(s.batch_id, '') = COALESCE(m.batch_id, '')
          WHERE COALESCE(s.on_hand, 0) <> COALESCE(m.oh, 0) OR COALESCE(s.blocked, 0) <> COALESCE(m.bl, 0)
             OR COALESCE(s.damaged, 0) <> COALESCE(m.dm, 0) OR COALESCE(s.expired, 0) <> COALESCE(m.ex, 0)`),

        // 2. Reserved per position = SUM of reserved deltas = open reservation lines.
        ...(await tx.$queryRaw<Row[]>`
          WITH m AS (
            SELECT variant_id, warehouse_id, batch_id, SUM(d_reserved) r
            FROM inventory_movement WHERE company_id = ${c} GROUP BY 1, 2, 3),
          o AS (
            SELECT r.variant_id, r.warehouse_id, l.batch_id, SUM(l.qty - l.qty_fulfilled - l.qty_released) r
            FROM reservation r JOIN reservation_line l ON l.reservation_id = r.id
            WHERE r.company_id = ${c} GROUP BY 1, 2, 3),
          a AS (SELECT * FROM stock_allocation WHERE company_id = ${c}),
          am AS (
            SELECT COALESCE(a.variant_id, m.variant_id) variant_id, COALESCE(a.warehouse_id, m.warehouse_id) warehouse_id,
                   COALESCE(a.batch_id, m.batch_id) batch_id, COALESCE(a.qty_reserved, 0) actual, COALESCE(m.r, 0) moved
            FROM a FULL JOIN m ON a.variant_id = m.variant_id AND a.warehouse_id = m.warehouse_id
              AND COALESCE(a.batch_id, '') = COALESCE(m.batch_id, ''))
          SELECT 'reserved' AS "check",
                 COALESCE(am.variant_id, o.variant_id) variant_id, COALESCE(am.warehouse_id, o.warehouse_id) warehouse_id,
                 COALESCE(am.batch_id, o.batch_id) batch_id,
                 concat_ws('/', trim_scale(COALESCE(am.moved, 0)), trim_scale(COALESCE(o.r, 0))) expected, trim_scale(COALESCE(am.actual, 0))::text actual
          FROM am FULL JOIN o ON am.variant_id = o.variant_id AND am.warehouse_id = o.warehouse_id
            AND COALESCE(am.batch_id, '') = COALESCE(o.batch_id, '')
          WHERE COALESCE(am.actual, 0) <> COALESCE(am.moved, 0) OR COALESCE(am.actual, 0) <> COALESCE(o.r, 0)`),

        // 3. I-02: reserved ≤ SUM(on_hand) per position.
        ...(await tx.$queryRaw<Row[]>`
          SELECT 'reserved_le_on_hand' AS "check", a.variant_id, a.warehouse_id, a.batch_id,
                 trim_scale(COALESCE(SUM(s.on_hand), 0))::text expected, trim_scale(a.qty_reserved)::text actual
          FROM stock_allocation a LEFT JOIN stock_balance s ON s.variant_id = a.variant_id
            AND s.warehouse_id = a.warehouse_id AND s.batch_id IS NOT DISTINCT FROM a.batch_id
          WHERE a.company_id = ${c}
          GROUP BY a.id HAVING a.qty_reserved > COALESCE(SUM(s.on_hand), 0)`),

        // 4. Valuation layer: qty = SUM(physical deltas), value = SUM(value_delta) (INV-022).
        ...(await tx.$queryRaw<Row[]>`
          WITH m AS (
            SELECT variant_id, warehouse_id, SUM(d_on_hand + d_blocked + d_damaged + d_expired) q, SUM(value_delta) v
            FROM inventory_movement WHERE company_id = ${c} GROUP BY 1, 2),
          k AS (SELECT * FROM variant_cost WHERE company_id = ${c})
          SELECT 'cost' AS "check",
                 COALESCE(k.variant_id, m.variant_id) variant_id, COALESCE(k.warehouse_id, m.warehouse_id) warehouse_id,
                 NULL AS batch_id,
                 concat_ws('/', trim_scale(COALESCE(m.q, 0)), trim_scale(COALESCE(m.v, 0))) expected,
                 concat_ws('/', trim_scale(COALESCE(k.qty, 0)), trim_scale(COALESCE(k.value, 0))) actual
          FROM k FULL JOIN m ON k.variant_id = m.variant_id AND k.warehouse_id = m.warehouse_id
          WHERE COALESCE(k.qty, 0) <> COALESCE(m.q, 0) OR COALESCE(k.value, 0) <> COALESCE(m.v, 0)`),
      ];
      return rows.map(({ check, expected, actual, ...key }) => ({ check, key, expected: String(expected), actual: String(actual) }));
    },
    { isolationLevel: "RepeatableRead", timeout: 60_000 },
  );
}
