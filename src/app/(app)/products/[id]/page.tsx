import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/app/ui/action-form";
import { Denied } from "@/app/ui/denied";
import { listAudit } from "@/server/audit/queries";
import { pageData } from "@/server/auth/page-ctx";
import { checkBarcode, getProduct } from "@/server/catalog/catalog";
import { listBrands, listCategories, listUoms } from "@/server/catalog/taxonomy";
import { listMovements, stockSummary } from "@/server/inventory/queries";
import { listWarehouses } from "@/server/warehouses/warehouses";
import {
  addVariantAction, conversionAction, imageAction, productStatusAction, reorderAction, replaceSkuAction, updateProductAction, updateVariantAction,
} from "../actions";

export const metadata: Metadata = { title: "Product" };

const TABS = ["info", "variants", "stock", "movements", "suppliers", "history"] as const;
type Tab = (typeof TABS)[number];
// Doc 23 — what the status menu offers from each state.
const NEXT: Record<string, string[]> = {
  draft: ["active", "archived"], active: ["inactive", "discontinued", "archived"],
  inactive: ["active", "discontinued", "archived"], discontinued: ["archived"], archived: [],
};
const attrs = (a: unknown) => Object.entries((a ?? {}) as Record<string, string>).map(([k, v]) => `${k}=${v}`).join(", ");
const s = (v: unknown) => (v === null || v === undefined ? "" : String(v));

export default async function ProductPage({ params, searchParams }: PageProps<"/products/[id]">) {
  const { id } = await params;
  const sp = await searchParams;
  const tab = (TABS.find((t) => t === sp.tab) ?? "info") as Tab;

  const res = await pageData(async (ctx) => {
    const p = await getProduct(ctx, id);
    const can = (g: string) => ctx.permissions.has(g);
    const variantIds = p.variants.map((v) => v.id);
    const vSel = p.variants.find((v) => v.id === sp.v) ?? p.variants[0];
    const [categories, brands, uoms, warehouses, stock, movements, history] = await Promise.all([
      tab === "info" && can("products.update") ? listCategories(ctx) : [],
      tab === "info" && can("products.update") ? listBrands(ctx) : [],
      tab === "info" || tab === "variants" ? listUoms(ctx) : [],
      tab === "variants" && can("products.update") ? listWarehouses(ctx).catch(() => []) : [],
      (tab === "stock" || tab === "variants") && can("inventory.view") ? stockSummary(ctx, variantIds) : null,
      tab === "movements" && can("inventory.view") && vSel ? listMovements(ctx, { page: 1, perPage: 100, variantId: vSel.id }) : null,
      tab === "history" && can("audit.view")
        ? Promise.all([listAudit(ctx, { page: 1, perPage: 50, entityId: p.id }), vSel ? listAudit(ctx, { page: 1, perPage: 50, entityId: vSel.id }) : null])
        : null,
    ]);
    const whCodes = Object.fromEntries((await listWarehouses(ctx).catch(() => [])).map((w) => [w.id, w.code]));
    return { p, vSel, categories, brands, uoms, warehouses, stock, movements, history, whCodes, canEdit: can("products.update"), canArchive: can("products.archive") };
  });
  if ("denied" in res) return <Denied message={res.denied} />;
  const { p, vSel, categories, brands, uoms, warehouses, stock, movements, history, whCodes, canEdit, canArchive } = res.data;
  const archived = p.status === "archived";
  const editable = canEdit && !archived;
  const statusOptions = NEXT[p.status].filter((x) => x !== "archived" || canArchive);

  return (
    <div className="flex max-w-6xl flex-col gap-6">
      <div>
        <Link href="/products" className="link text-sm">← Products</Link>
        <h1 className="h1 mt-1">{p.name}</h1>
        <p className="text-sm text-muted">
          {p.type === "simple" ? "Simple product" : `${p.variants.length} variants`} · {p.status}
          {p.category && ` · ${p.category.path.slice(1, -1).replaceAll("/", " › ")}`}{p.brand && ` · ${p.brand.name}`} · base unit {p.baseUom}
        </p>
      </div>

      <nav aria-label="Product sections" className="flex gap-1 overflow-x-auto border-b border-border">
        {TABS.map((t) => (
          <Link key={t} href={`?tab=${t}`} aria-current={t === tab ? "page" : undefined}
            className={`whitespace-nowrap px-3 py-2 text-sm capitalize ${t === tab ? "border-b-2 border-accent font-medium" : "text-muted"}`}>{t}</Link>
        ))}
      </nav>

      {tab === "info" && (
        <>
          <section className="card">
            <h2 className="mb-3 font-semibold">Details</h2>
            {editable ? (
              <ActionForm action={updateProductAction.bind(null, p.id)}>
                <input type="hidden" name="version" value={p.version} />
                <div className="grid gap-3 sm:grid-cols-3">
                  <label className="label sm:col-span-2">Name<input name="name" defaultValue={p.name} required minLength={2} maxLength={200} className="input" /></label>
                  <label className="label">
                    Type
                    <select name="type" defaultValue={p.type} className="input">
                      <option value="simple">Simple (one SKU)</option><option value="variant_parent">With variants</option>
                    </select>
                  </label>
                  <label className="label sm:col-span-3">Description<textarea name="description" defaultValue={p.description ?? ""} rows={3} className="input" /></label>
                  <label className="label">
                    Category
                    <select name="categoryId" defaultValue={p.categoryId ?? ""} className="input">
                      <option value="">—</option>
                      {categories.map((c) => <option key={c.id} value={c.id}>{"  ".repeat(c.depth - 1)}{c.name}</option>)}
                    </select>
                  </label>
                  <label className="label">
                    Brand
                    <select name="brandId" defaultValue={p.brandId ?? ""} className="input">
                      <option value="">—</option>
                      {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                    </select>
                  </label>
                  <label className="label">
                    Base unit
                    <select name="baseUom" defaultValue={p.baseUom} className="input">
                      {uoms.map((u) => <option key={u.code} value={u.code}>{u.name} ({u.code})</option>)}
                    </select>
                  </label>
                  <label className="label">Tags<input name="tags" defaultValue={p.tags.join(", ")} placeholder="comma, separated" className="input" /></label>
                  <label className="label">Default shelf life (days)<input name="trackExpiryDefaultDays" type="number" min={1} defaultValue={s(p.trackExpiryDefaultDays)} className="input" /></label>
                </div>
                <fieldset className="flex flex-wrap gap-4 text-sm">
                  <legend className="mb-1 text-sm font-medium">Tracking (fixed once stock moves)</legend>
                  <label className="flex items-center gap-2"><input type="checkbox" name="requiresBatch" defaultChecked={p.requiresBatch} /> Batches</label>
                  <label className="flex items-center gap-2"><input type="checkbox" name="requiresExpiry" defaultChecked={p.requiresExpiry} /> Expiry dates</label>
                  <label className="flex items-center gap-2"><input type="checkbox" name="isSerialized" defaultChecked={p.isSerialized} /> Serial numbers</label>
                  <label className="flex items-center gap-2"><input type="checkbox" name="requiresInspection" defaultChecked={p.requiresInspection} /> Inspect on receipt</label>
                </fieldset>
              </ActionForm>
            ) : (
              <dl className="grid gap-2 text-sm sm:grid-cols-2">
                <div><dt className="text-muted">Description</dt><dd>{p.description || "—"}</dd></div>
                <div><dt className="text-muted">Tracking</dt><dd>{[p.requiresBatch && "batches", p.requiresExpiry && "expiry", p.isSerialized && "serials"].filter(Boolean).join(", ") || "none"}</dd></div>
                <div><dt className="text-muted">Tags</dt><dd>{p.tags.join(", ") || "—"}</dd></div>
              </dl>
            )}
          </section>

          {(editable || (canArchive && !archived)) && statusOptions.length > 0 && (
            <section className="card">
              <h2 className="mb-1 font-semibold">Status</h2>
              <p className="mb-3 text-sm text-muted">Discontinued blocks new orders and reservations; archived blocks everything and hides the product. Stock on hand stays until sold, moved or written off.</p>
              <ActionForm action={productStatusAction.bind(null, p.id)} submit="Change status" className="flex flex-wrap items-end gap-3">
                <input type="hidden" name="version" value={p.version} />
                <label className="label">
                  Move from {p.status} to
                  <select name="status" className="input">{statusOptions.map((x) => <option key={x}>{x}</option>)}</select>
                </label>
              </ActionForm>
            </section>
          )}

          <section className="card">
            <h2 className="mb-1 font-semibold">Unit conversions</h2>
            <p className="mb-3 text-sm text-muted">1 unit = factor × {p.baseUom}. A new factor applies from now on; earlier documents keep the factor they used.</p>
            {p.conversions.length > 0 && (
              <table className="table mb-3">
                <thead><tr><th>Unit</th><th>Factor</th><th>Effective from</th></tr></thead>
                <tbody>
                  {p.conversions.map((c) => <tr key={c.id}><td>{c.uom}</td><td className="tabular-nums">{c.factor.toString()}</td><td>{c.effectiveFrom.toLocaleString()}</td></tr>)}
                </tbody>
              </table>
            )}
            {editable && (
              <ActionForm action={conversionAction.bind(null, p.id)} submit="Set factor" className="flex flex-wrap items-end gap-3">
                <label className="label">
                  Unit
                  <select name="uom" className="input">{uoms.filter((u) => u.code !== p.baseUom).map((u) => <option key={u.code} value={u.code}>{u.name}</option>)}</select>
                </label>
                <label className="label">Factor<input name="factor" type="number" min="0.000001" step="any" required className="input w-32" /></label>
              </ActionForm>
            )}
          </section>
        </>
      )}

      {tab === "variants" && (
        <>
          {p.variants.map((v) => {
            const vArchived = v.status === "archived" || archived;
            const rows = stock?.filter((r) => r.variantId === v.id) ?? [];
            return (
              <section key={v.id} className="card flex flex-col gap-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h2 className="font-mono font-semibold">{v.sku}</h2>
                  <span className="text-sm text-muted">{v.status}{v.barcode && ` · barcode ${v.barcode}`}</span>
                </div>
                {checkBarcode(v.barcode).warning && <p role="status" className="text-sm text-amber-700">{checkBarcode(v.barcode).warning}</p>}
                {(v.skuAliases.length > 0 || v.barcodeAliases.length > 0) && (
                  <p className="text-sm text-muted">
                    {v.skuAliases.length > 0 && <>Also scans as old SKU {v.skuAliases.map((a) => a.oldSku).join(", ")}. </>}
                    {v.barcodeAliases.map((a) => <span key={a.id}>Old barcode {a.barcode} scans until {a.expiresAt.toLocaleDateString()}. </span>)}
                  </p>
                )}
                {editable && !vArchived && (
                  <ActionForm action={updateVariantAction.bind(null, v.id)}>
                    <input type="hidden" name="version" value={v.version} />
                    <div className="grid gap-3 sm:grid-cols-4">
                      <label className="label">SKU<input name="sku" defaultValue={v.sku} className="input font-mono uppercase" /></label>
                      <label className="label">Barcode<input name="barcode" defaultValue={v.barcode ?? ""} className="input font-mono" /></label>
                      <label className="label">Variant name<input name="variantName" defaultValue={v.name ?? ""} placeholder="e.g. Red / M" className="input" /></label>
                      <label className="label">Attributes<input name="attributes" defaultValue={attrs(v.attributes)} placeholder="size=M, color=Red" className="input" /></label>
                      <label className="label">Sell price<input name="sellPrice" type="number" min={0} step="0.0001" defaultValue={s(v.sellPrice)} className="input" /></label>
                      <label className="label">Min sell price<input name="minSellPrice" type="number" min={0} step="0.0001" defaultValue={s(v.minSellPrice)} className="input" /></label>
                      <label className="label">Cost price (reference)<input name="costPrice" type="number" min={0} step="0.0001" defaultValue={s(v.costPrice)} className="input" /></label>
                      <label className="label">Weight (kg)<input name="weightKg" type="number" min={0} step="0.0001" defaultValue={s(v.weightKg)} className="input" /></label>
                      <label className="label">
                        Status
                        <select name="status" defaultValue={v.status} className="input">
                          {[v.status, ...NEXT[v.status].filter((x) => x !== "archived" || canArchive)].map((x) => <option key={x}>{x}</option>)}
                        </select>
                      </label>
                      <label className="flex items-center gap-2 self-end pb-2 text-sm"><input type="checkbox" name="requiresInspection" defaultChecked={v.requiresInspection} /> Inspect on receipt</label>
                    </div>
                    <p className="text-xs text-muted">The SKU can change until stock first moves; after that use “Replace SKU”. A changed barcode keeps scanning for the configured days.</p>
                  </ActionForm>
                )}

                {editable && !vArchived && (
                  <details className="text-sm">
                    <summary className="cursor-pointer font-medium">Replace SKU (after stock has moved)</summary>
                    <p className="my-2 text-muted">Creates a new variant with the new SKU, makes the old SKU scan as an alias of it, and discontinues this one so its stock sells through or is moved.</p>
                    <ActionForm action={replaceSkuAction.bind(null, v.id)} submit="Replace SKU" className="flex flex-wrap items-end gap-3">
                      <input type="hidden" name="version" value={v.version} />
                      <label className="label">New SKU<input name="newSku" required className="input font-mono uppercase" /></label>
                    </ActionForm>
                  </details>
                )}

                {(editable || v.warehouseSettings.length > 0) && (
                  <div>
                    <h3 className="mb-2 text-sm font-medium">Reorder settings per warehouse</h3>
                    {v.warehouseSettings.length > 0 && (
                      <table className="table mb-2">
                        <thead><tr><th>Warehouse</th><th>Reorder point</th><th>Reorder qty</th><th>Max</th>{stock && <th>Available</th>}</tr></thead>
                        <tbody>
                          {v.warehouseSettings.map((ws) => {
                            const r = rows.find((x) => x.warehouseId === ws.warehouseId);
                            return (
                              <tr key={ws.warehouseId}>
                                <td>{ws.warehouse.code}</td><td>{s(ws.reorderPoint) || "—"}</td><td>{s(ws.reorderQty) || "—"}</td><td>{s(ws.maxStock) || "—"}</td>
                                {stock && <td>{r?.available ?? 0}{r?.belowReorder && <span className="ml-2 text-xs text-amber-700">reorder</span>}</td>}
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    )}
                    {editable && warehouses.length > 0 && (
                      <ActionForm action={reorderAction.bind(null, v.id)} submit="Save" className="flex flex-wrap items-end gap-3">
                        <label className="label">
                          Warehouse
                          <select name="warehouseId" className="input">{warehouses.map((w) => <option key={w.id} value={w.id}>{w.code}</option>)}</select>
                        </label>
                        <label className="label">Reorder point<input name="reorderPoint" type="number" min={0} step="any" className="input w-28" /></label>
                        <label className="label">Reorder qty<input name="reorderQty" type="number" min={0} step="any" className="input w-28" /></label>
                        <label className="label">Max stock<input name="maxStock" type="number" min={0} step="any" className="input w-28" /></label>
                      </ActionForm>
                    )}
                  </div>
                )}

                <div>
                  <h3 className="mb-2 text-sm font-medium">Images</h3>
                  <div className="mb-2 flex flex-wrap gap-2">
                    {v.images.map((img) => (
                      // eslint-disable-next-line @next/next/no-img-element -- arbitrary external URLs, no loader configured
                      <img key={img.id} src={img.url} alt={`${v.sku} image ${img.sort + 1}`} className="h-20 w-20 rounded border border-border object-cover" />
                    ))}
                    {v.images.length === 0 && <span className="text-sm text-muted">None yet.</span>}
                  </div>
                  {editable && !vArchived && (
                    <ActionForm action={imageAction.bind(null, v.id)} submit="Add image" className="flex flex-wrap items-end gap-3">
                      <label className="label grow">Image URL<input name="url" type="url" pattern="https://.*" required className="input" /></label>
                    </ActionForm>
                  )}
                </div>

                {v.batches.length > 0 && (
                  <div>
                    <h3 className="mb-2 text-sm font-medium">Batches</h3>
                    <p className="text-sm">{v.batches.map((b) => `${b.batchNo}${b.expiryDate ? ` (exp ${b.expiryDate.toISOString().slice(0, 10)})` : ""}`).join(" · ")}</p>
                  </div>
                )}
              </section>
            );
          })}

          {editable && p.type === "variant_parent" && (
            <section className="card">
              <h2 className="mb-3 font-semibold">Add variant</h2>
              <ActionForm action={addVariantAction.bind(null, p.id)} submit="Add variant">
                <div className="grid gap-3 sm:grid-cols-4">
                  <label className="label">SKU<input name="sku" required className="input font-mono uppercase" /></label>
                  <label className="label">Barcode<input name="barcode" className="input font-mono" /></label>
                  <label className="label">Variant name<input name="variantName" placeholder="e.g. Blue / L" className="input" /></label>
                  <label className="label">Attributes<input name="attributes" placeholder="size=L, color=Blue" className="input" /></label>
                  <label className="label">Sell price<input name="sellPrice" type="number" min={0} step="0.0001" className="input" /></label>
                </div>
              </ActionForm>
            </section>
          )}
        </>
      )}

      {tab === "stock" && (
        stock === null ? <p className="text-sm text-muted">You don’t have access to stock levels.</p> : (
          <div className="card overflow-x-auto p-0">
            <table className="table">
              <thead><tr><th>SKU</th><th>Warehouse</th><th className="text-right">On hand</th><th className="text-right">Reserved</th><th className="text-right">Available</th><th className="text-right">Blocked</th><th className="text-right">Damaged</th><th className="text-right">Expired</th></tr></thead>
              <tbody>
                {stock.length === 0 && <tr><td colSpan={8} className="text-muted">No stock in your warehouses yet.</td></tr>}
                {stock.map((r) => (
                  <tr key={`${r.variantId}${r.warehouseId}`}>
                    <td className="font-mono text-xs">{p.variants.find((v) => v.id === r.variantId)?.sku}</td>
                    <td>{whCodes[r.warehouseId] ?? r.warehouseId}</td>
                    {[r.onHand, r.reserved, r.available, r.blocked, r.damaged, r.expired].map((n, i) => <td key={i} className="text-right tabular-nums">{n.toLocaleString()}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}

      {(tab === "movements" || tab === "history") && p.variants.length > 1 && (
        <form className="flex items-end gap-2">
          <input type="hidden" name="tab" value={tab} />
          <label className="label">Variant
            <select name="v" defaultValue={vSel?.id} className="input">{p.variants.map((v) => <option key={v.id} value={v.id}>{v.sku}</option>)}</select>
          </label>
          <button className="btn">Show</button>
        </form>
      )}

      {tab === "movements" && (
        movements === null ? <p className="text-sm text-muted">You don’t have access to the stock ledger.</p> : (
          <div className="card overflow-x-auto p-0">
            <table className="table">
              <thead><tr><th>When</th><th>Type</th><th>Warehouse</th><th className="text-right">Δ on hand</th><th className="text-right">Δ reserved</th><th>Source</th></tr></thead>
              <tbody>
                {movements.items.length === 0 && <tr><td colSpan={6} className="text-muted">No movements yet.</td></tr>}
                {movements.items.map((m) => (
                  <tr key={m.id}>
                    <td className="whitespace-nowrap">{m.createdAt.toLocaleString()}</td><td>{m.type}</td><td>{whCodes[m.warehouseId] ?? "—"}</td>
                    <td className="text-right tabular-nums">{m.dOnHand.toString()}</td><td className="text-right tabular-nums">{m.dReserved.toString()}</td>
                    <td className="text-xs text-muted">{m.sourceType}:{m.sourceId.slice(0, 12)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}

      {tab === "suppliers" && (
        <div className="card overflow-x-auto p-0">
          <table className="table">
            <thead><tr><th>SKU</th><th>Supplier</th><th>Supplier SKU</th><th className="text-right">Last price</th><th>Lead days</th><th /></tr></thead>
            <tbody>
              {p.variants.every((v) => v.supplierProducts.length === 0) && <tr><td colSpan={6} className="text-muted">No suppliers linked. Link products from a supplier’s page.</td></tr>}
              {p.variants.flatMap((v) => v.supplierProducts.map((sp) => (
                <tr key={`${v.id}${sp.supplierId}`}>
                  <td className="font-mono text-xs">{v.sku}</td>
                  <td><Link href={`/suppliers/${sp.supplier.id}`} className="link">{sp.supplier.code} · {sp.supplier.name}</Link></td>
                  <td>{sp.supplierSku ?? "—"}</td>
                  <td className="text-right tabular-nums">{sp.lastPrice ? `${sp.lastPrice} ${sp.supplier.currency}` : "—"}</td>
                  <td>{sp.leadDays ?? "—"}</td>
                  <td>{sp.isPreferred && <span className="text-xs text-green-700">preferred</span>}</td>
                </tr>
              )))}
            </tbody>
          </table>
        </div>
      )}

      {tab === "history" && (
        history === null ? <p className="text-sm text-muted">You don’t have access to the audit log.</p> : (
          <div className="card overflow-x-auto p-0">
            <table className="table">
              <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Record</th></tr></thead>
              <tbody>
                {[...history[0].items, ...(history[1]?.items ?? [])].sort((a, b) => b.id.localeCompare(a.id)).map((a) => (
                  <tr key={a.id}>
                    <td className="whitespace-nowrap"><Link href={`/admin/audit/${a.id}`} className="link">{a.at.toLocaleString()}</Link></td>
                    <td>{a.actor?.name ?? "system"}</td><td>{a.action}</td><td>{a.entityType}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
    </div>
  );
}
