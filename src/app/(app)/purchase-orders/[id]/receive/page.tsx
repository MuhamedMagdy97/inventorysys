import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/app/ui/action-form";
import { Denied } from "@/app/ui/denied";
import { pageData } from "@/server/auth/page-ctx";
import { AppError } from "@/server/core/errors";
import { db } from "@/server/db";
import { getPo } from "@/server/purchasing/purchase-orders";
import { receiveAction } from "../../actions";

export const metadata: Metadata = { title: "Receive goods" };

const n = (d: { toString(): string }) => Number(d.toString()).toLocaleString(undefined, { maximumFractionDigits: 4 });

// Flow 6/7 receiving form. Quantities are in each line's order unit; accepted defaults to
// the open remainder. The Idempotency-Key is rendered into the form, so a double submit
// or refresh-resubmit replays the first GRN instead of posting twice (RC-01, edge #16).
export default async function ReceivePage({ params }: PageProps<"/purchase-orders/[id]/receive">) {
  const { id } = await params;
  const res = await pageData(async (ctx) => {
    const po = await getPo(ctx, id);
    if (!po.canReceive) throw new AppError("forbidden", `This PO can't be received by you now (status ${po.status.replace("_", " ")})`);
    const bins = await db.bin.findMany({
      where: { warehouseId: po.warehouseId, archived: false, type: { in: ["receiving", "sellable"] } },
      orderBy: [{ isDefaultReceiving: "desc" }, { code: "asc" }], select: { id: true, code: true, type: true },
    });
    return { po, bins };
  });
  if ("denied" in res) return <Denied message={res.denied} />;
  const { po, bins } = res.data;
  const key = crypto.randomUUID();
  const lines = po.lines.filter((l) => !l.removed);

  return (
    <div className="flex max-w-6xl flex-col gap-6">
      <div>
        <Link href={`/purchase-orders/${po.id}`} className="link text-sm">← {po.number}</Link>
        <h1 className="h1 mt-1">Receive {po.number}</h1>
        <p className="text-sm text-muted">{po.supplier.name} → {po.warehouse.code}{po.supplier.requiresInspection && " · supplier requires inspection: accepted units go to quarantine"}</p>
      </div>
      <ActionForm action={receiveAction.bind(null, po.id, key)} submit="Post receipt">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="label">Delivery note / invoice ref<input name="supplierRef" className="input" autoFocus /></label>
          <label className="label">Note<input name="note" className="input" /></label>
        </div>
        {lines.map((l, i) => {
          const remaining = Math.max(0, (Number(l.qtyOrderedBase) - Number(l.qtyReceivedBase)) / Number(l.uomFactor));
          const p = `rcv.${i}.`;
          const serialized = l.variant.product.isSerialized;
          return (
            <fieldset key={l.id} className="card flex flex-col gap-2">
              <legend className="px-1 text-sm font-semibold">
                {l.lineNo}. <span className="font-mono">{l.sku}</span> {l.name} — ordered {n(l.qtyOrdered)} {l.orderUom}, received {n(l.qtyReceivedBase)} {l.variant.product.baseUom}
                {l.variant.requiresInspection && " · inspection"}
              </legend>
              <input type="hidden" name={`${p}poLineId`} value={l.id} />
              <div className="flex flex-wrap items-end gap-3">
                <label className="label">Accepted ({l.orderUom})<input name={`${p}accepted`} defaultValue={remaining || ""} inputMode="decimal" className="input w-24" /></label>
                <label className="label">Damaged<input name={`${p}damaged`} inputMode="decimal" className="input w-20" /></label>
                <label className="label">Expired<input name={`${p}expired`} inputMode="decimal" className="input w-20" /></label>
                <label className="label">Missing<input name={`${p}missing`} inputMode="decimal" className="input w-20" /></label>
                <label className="label">
                  Bin
                  <select name={`${p}binId`} className="input">{bins.map((b) => <option key={b.id} value={b.id}>{b.code} ({b.type})</option>)}</select>
                </label>
                {l.requiresBatch && <label className="label">Batch no.<input name={`${p}batchNo`} required className="input w-32" /></label>}
                {l.requiresExpiry && <label className="label">Expiry<input name={`${p}expiryDate`} type="date" required className="input" /></label>}
                <label className="label grow">Line note<input name={`${p}note`} className="input" /></label>
              </div>
              {serialized && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="label">Serials — accepted (scan one per line)<textarea name={`${p}serials`} rows={3} className="input font-mono" /></label>
                  <label className="label">Serials — damaged / expired<textarea name={`${p}damagedSerials`} rows={3} className="input font-mono" /></label>
                </div>
              )}
            </fieldset>
          );
        })}
        <fieldset className="card flex flex-col gap-2">
          <legend className="px-1 text-sm font-semibold">Arrived but not on this PO (wrong product)</legend>
          {[0, 1].map((i) => (
            <div key={i} className="flex flex-wrap items-end gap-3">
              <label className="label">SKU / barcode<input name={`wrong.${i}.sku`} className="input w-40 font-mono" /></label>
              <label className="label">Qty (base)<input name={`wrong.${i}.qty`} inputMode="decimal" className="input w-20" /></label>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" name={`wrong.${i}.held`} defaultChecked /> Kept on site (quarantined)</label>
              <label className="label">Batch no.<input name={`wrong.${i}.batchNo`} className="input w-28" /></label>
              <label className="label">Expiry<input name={`wrong.${i}.expiryDate`} type="date" className="input" /></label>
              <label className="label">Serials<input name={`wrong.${i}.serials`} className="input w-40 font-mono" /></label>
              <label className="label grow">Note<input name={`wrong.${i}.note`} className="input" /></label>
            </div>
          ))}
        </fieldset>
        <p className="text-xs text-muted">Units over the ordered quantity plus tolerance are held as blocked until a purchasing approver decides. Damaged units go to the damaged bin, expired ones to quarantine.</p>
      </ActionForm>
    </div>
  );
}
