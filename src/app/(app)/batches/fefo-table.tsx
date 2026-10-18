import type { ExpiryStatus, fefoView } from "@/server/inventory/tracking";

const n = (s: string) => Number(s).toLocaleString(undefined, { maximumFractionDigits: 4 });
// Expiry colouring (doc 25): red expired, amber inside the alert horizon, muted no expiry.
export const EXPIRY_CLASS: Record<ExpiryStatus, string> = { expired: "text-red-600 font-medium", expiring: "text-amber-700 font-medium", ok: "", none: "text-muted" };

export function FefoTable({ rows }: { rows: Awaited<ReturnType<typeof fefoView>>["rows"] }) {
  return (
    <div className="card overflow-x-auto p-0">
      <table className="table">
        <thead>
          <tr>
            <th>Warehouse</th><th>Pick #</th><th>Batch</th><th>Expiry</th><th className="text-right">Days left</th>
            <th className="text-right">On hand</th><th className="text-right">Reserved</th><th className="text-right">Available</th>
            <th className="text-right">Blocked</th><th className="text-right">Damaged</th><th className="text-right">Expired</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan={11} className="text-muted">No batch stock in your warehouses.</td></tr>}
          {rows.map((r) => (
            <tr key={`${r.warehouseId}${r.batchId}`}>
              <td>{r.warehouseCode}</td>
              <td className="tabular-nums">{r.pickRank ?? "—"}</td>
              <td className="font-mono text-xs">{r.batchNo}</td>
              <td className={EXPIRY_CLASS[r.status]}>{r.expiryDate ? r.expiryDate.toISOString().slice(0, 10) : "no expiry"}{r.status === "expired" && " · expired"}</td>
              <td className={`text-right tabular-nums ${EXPIRY_CLASS[r.status]}`}>{r.daysLeft ?? "—"}</td>
              {[r.onHand, r.reserved, r.available, r.blocked, r.damaged, r.expired].map((v, i) => <td key={i} className="text-right tabular-nums">{n(v)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

