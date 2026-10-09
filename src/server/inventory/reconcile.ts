import { requirePermission, type Ctx } from "@/server/core/ctx";
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
  await requirePermission(ctx, "inventory.view");
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

        // 5. I-06: serialized positions — SUM(on_hand) = live units (in_stock + reserved).
        ...(await tx.$queryRaw<Row[]>`
          WITH s AS (
            SELECT b.variant_id, b.warehouse_id, b.batch_id, SUM(b.on_hand) q
            FROM stock_balance b JOIN product_variant v ON v.id = b.variant_id JOIN product p ON p.id = v.product_id
            WHERE b.company_id = ${c} AND p.is_serialized GROUP BY 1, 2, 3),
          u AS (
            SELECT variant_id, warehouse_id, batch_id, COUNT(*)::numeric q FROM serial_unit
            WHERE company_id = ${c} AND status IN ('in_stock', 'reserved') GROUP BY 1, 2, 3)
          SELECT 'serials' AS "check", COALESCE(s.variant_id, u.variant_id) variant_id, COALESCE(s.warehouse_id, u.warehouse_id) warehouse_id,
                 COALESCE(s.batch_id, u.batch_id) batch_id, trim_scale(COALESCE(s.q, 0))::text expected, trim_scale(COALESCE(u.q, 0))::text actual
          FROM s FULL JOIN u ON s.variant_id = u.variant_id AND s.warehouse_id = u.warehouse_id AND s.batch_id IS NOT DISTINCT FROM u.batch_id
          WHERE COALESCE(s.q, 0) <> COALESCE(u.q, 0)`),

        // 4. Valuation layer: qty = SUM(physical deltas), value = SUM(value_delta) (INV-022).
        ...(await tx.$queryRaw<Row[]>`
          WITH m AS (
            SELECT variant_id, warehouse_id, SUM(d_on_hand + d_blocked + d_damaged + d_expired) q, SUM(value_delta) v
            FROM inventory_movement WHERE company_id = ${c} AND type <> 'transfer_variance' GROUP BY 1, 2),
          k AS (SELECT * FROM variant_cost WHERE company_id = ${c})
          SELECT 'cost' AS "check",
                 COALESCE(k.variant_id, m.variant_id) variant_id, COALESCE(k.warehouse_id, m.warehouse_id) warehouse_id,
                 NULL AS batch_id,
                 concat_ws('/', trim_scale(COALESCE(m.q, 0)), trim_scale(COALESCE(m.v, 0))) expected,
                 concat_ws('/', trim_scale(COALESCE(k.qty, 0)), trim_scale(COALESCE(k.value, 0))) actual
          FROM k FULL JOIN m ON k.variant_id = m.variant_id AND k.warehouse_id = m.warehouse_id
          WHERE COALESCE(k.qty, 0) <> COALESCE(m.q, 0) OR COALESCE(k.value, 0) <> COALESCE(m.v, 0)`),

        // 7. Quarantine lots (doc 25 Inspection): open lot qty per bin row = blocked.
        ...(await tx.$queryRaw<Row[]>`
          WITH q AS (
            SELECT variant_id, warehouse_id, bin_id, batch_id, SUM(qty_open) q
            FROM quarantine_lot WHERE company_id = ${c} GROUP BY 1, 2, 3, 4),
          s AS (SELECT * FROM stock_balance WHERE company_id = ${c} AND blocked <> 0)
          SELECT 'quarantine_lots' AS "check", COALESCE(s.variant_id, q.variant_id) variant_id, COALESCE(s.warehouse_id, q.warehouse_id) warehouse_id,
                 COALESCE(s.bin_id, q.bin_id) bin_id, COALESCE(s.batch_id, q.batch_id) batch_id,
                 trim_scale(COALESCE(s.blocked, 0))::text expected, trim_scale(COALESCE(q.q, 0))::text actual
          FROM s FULL JOIN q ON s.variant_id = q.variant_id AND s.warehouse_id = q.warehouse_id
            AND s.bin_id = q.bin_id AND s.batch_id IS NOT DISTINCT FROM q.batch_id
          WHERE COALESCE(s.blocked, 0) <> COALESCE(q.q, 0)`),

        // 6. In-transit per transfer: ledger (doc 11 §5) = open line value and qty (I-04).
        ...(await tx.$queryRaw<Row[]>`
          WITH m AS (
            SELECT split_part(source_id, ':', 1) id,
                   SUM(CASE WHEN type = 'transfer_variance' THEN value_delta ELSE -value_delta END) v,
                   SUM(-(d_on_hand + d_damaged)) q
            FROM inventory_movement
            WHERE company_id = ${c} AND source_type IN ('transfer_shipment', 'transfer_receipt', 'transfer_variance') GROUP BY 1),
          l AS (
            SELECT t.id, SUM(l.shipped_value - l.settled_value) v, SUM(l.qty_shipped - l.qty_received - l.qty_damaged) q
            FROM transfer t JOIN transfer_line l ON l.transfer_id = t.id WHERE t.company_id = ${c} GROUP BY 1)
          SELECT 'in_transit' AS "check", l.id AS variant_id /* the transfer id */, NULL AS warehouse_id, NULL AS batch_id,
                 concat_ws('/', trim_scale(COALESCE(m.q, 0)), trim_scale(COALESCE(m.v, 0))) expected,
                 concat_ws('/', trim_scale(l.q), trim_scale(l.v)) actual
          FROM l LEFT JOIN m ON m.id = l.id
          WHERE COALESCE(m.v, 0) <> l.v OR COALESCE(m.q, 0) <> l.q`),
      ];
      return rows.map(({ check, expected, actual, ...key }) => ({ check, key, expected: String(expected), actual: String(actual) }));
    },
    { isolationLevel: "RepeatableRead", timeout: 60_000 },
  );
}
