import type { Metadata } from "next";
import { Denied } from "@/app/ui/denied";
import { pageData } from "@/server/auth/page-ctx";
import { variantByCode } from "@/server/catalog/catalog";
import { scopeFilter } from "@/server/core/ctx";
import { AppError } from "@/server/core/errors";
import { db } from "@/server/db";
import { fefoView } from "@/server/inventory/tracking";
import { FefoTable } from "./fefo-table";

export const metadata: Metadata = { title: "Batches · FEFO" };

const one = (v: string | string[] | undefined) => (typeof v === "string" && v ? v : undefined);

// Doc 25 "Batches / FEFO": batches by expiry per variant × warehouse, in the order the engine picks.
export default async function BatchesPage({ searchParams }: PageProps<"/batches">) {
  const sp = await searchParams;
  const sku = one(sp.sku), warehouseId = one(sp.warehouseId);
  const res = await pageData(async (ctx) => {
    const warehouses = await db.warehouse.findMany({ where: { companyId: ctx.companyId, id: scopeFilter(ctx) }, orderBy: { code: "asc" }, select: { id: true, code: true } });
    let variantId = one(sp.variantId), error: string | undefined;
    if (!variantId && sku) variantId = await variantByCode(ctx, sku).catch((e) => { if (e instanceof AppError) { error = e.message; return undefined; } throw e; });
    return { warehouses, error, view: variantId ? await fefoView(ctx, { variantId, warehouseId }) : null };
  });
  if ("denied" in res) return <Denied message={res.denied} />;
  const { warehouses, error, view } = res.data;

  return (
    <div className="flex max-w-6xl flex-col gap-6">
      <h1 className="h1">Batches · FEFO</h1>
      <form className="flex flex-wrap items-end gap-3" role="search">
        <label className="label">SKU or barcode<input name="sku" defaultValue={view?.sku ?? sku} required className="input font-mono" /></label>
        <label className="label">
          Warehouse
          <select name="warehouseId" defaultValue={warehouseId ?? ""} className="input">
            <option value="">All in my scope</option>
            {warehouses.map((w) => <option key={w.id} value={w.id}>{w.code}</option>)}
          </select>
        </label>
        <button className="btn">Show</button>
      </form>
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      {view && (
        <>
          {!view.requiresBatch && <p className="text-sm text-muted">{view.sku} is not batch-tracked.</p>}
          <p className="text-sm text-muted">
            Pick # is the order reserve and ship take batches (earliest expiry first, no-expiry last). Expired batches can&apos;t be reserved or shipped;
            amber = expires within {view.expiryAlertDays} days.
          </p>
          <FefoTable rows={view.rows} />
        </>
      )}
    </div>
  );
}
