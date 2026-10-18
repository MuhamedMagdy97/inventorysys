import type { Metadata } from "next";
import Link from "next/link";
import { Denied } from "@/app/ui/denied";
import { pageData } from "@/server/auth/page-ctx";
import { getSerialHistory } from "@/server/inventory/tracking";

export const metadata: Metadata = { title: "Serial" };

const label = (s: string) => s.replaceAll("_", " ");
const at = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");
// Source document of a movement, where it has its own screen.
const DOC: Record<string, (id: string) => string> = {
  transfer_shipment: (id) => `/transfers/${id}`, transfer_receipt: (id) => `/transfers/${id}`, transfer_variance: (id) => `/transfers/${id}`,
  stock_adjustment: (id) => `/adjustments/${id}`, stock_count: (id) => `/counts/${id}`,
  sales_return: (id) => `/returns/sales/${id}`, purchase_return: (id) => `/returns/purchase/${id}`,
  fulfilment: (id) => `/sales-orders?reservation=${id.split(":")[0]}`, reservation: (id) => `/sales-orders?reservation=${id}`,
};

// Doc 25 "Serial lifecycle": one unit's state changes, each with the movements of that posting.
export default async function SerialPage({ params }: PageProps<"/serials/[id]">) {
  const { id } = await params;
  const res = await pageData((ctx) => getSerialHistory(ctx, id));
  if ("denied" in res) return <Denied message={res.denied} />;
  const { unit, events } = res.data;

  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <div>
        <Link href="/serials" className="link text-sm">← Serials</Link>
        <h1 className="h1 mt-1 font-mono">{unit.serialNo}</h1>
        <p className="text-sm text-muted">
          <Link href={`/products/${unit.variant.productId}?tab=serials`} className="link font-mono">{unit.variant.sku}</Link>
          {unit.batch && ` · batch ${unit.batch.batchNo}${unit.batch.expiryDate ? ` (exp ${unit.batch.expiryDate.toISOString().slice(0, 10)})` : ""}`}
          {" "}· <strong>{label(unit.status)}</strong> at {unit.warehouse.code}{unit.bin && ` / ${unit.bin.code}`}
        </p>
      </div>

      <ol className="flex flex-col gap-3">
        {events.map((e) => (
          <li key={e.id} className="card">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-medium">
                {e.baseline ? <>State when history began: {label(e.toStatus)}</> : e.fromStatus ? <>{label(e.fromStatus)} → {label(e.toStatus)}</> : <>Created: {label(e.toStatus)}</>}
              </span>
              <span className="text-sm text-muted">{at(e.at)} · {e.warehouseCode ?? "—"}{e.binCode && ` / ${e.binCode}`}</span>
            </div>
            {e.movements.length > 0 && (
              <table className="table mt-2">
                <thead><tr><th>Movement</th><th>Warehouse / bin</th><th className="text-right">Δ on hand</th><th className="text-right">Δ damaged</th><th>Source</th></tr></thead>
                <tbody>
                  {e.movements.map((m) => (
                    <tr key={m.id}>
                      <td>{label(m.type)}</td>
                      <td>{m.warehouse.code}{m.bin && ` / ${m.bin.code}`}</td>
                      <td className="text-right tabular-nums">{m.dOnHand.toString()}</td>
                      <td className="text-right tabular-nums">{m.dDamaged.toString()}</td>
                      <td className="text-xs">
                        {DOC[m.sourceType] ? <Link href={DOC[m.sourceType](m.sourceId)} className="link">{label(m.sourceType)}</Link> : label(m.sourceType)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </li>
        ))}
      </ol>
      <p className="text-xs text-muted">Each step lists the stock movements posted with it for this SKU. Movements in warehouses outside your access are hidden.</p>
    </div>
  );
}
