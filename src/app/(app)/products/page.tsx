import type { Metadata } from "next";
import Link from "next/link";
import type { VariantStatus } from "@/generated/prisma/client";
import { ActionForm } from "@/app/ui/action-form";
import { Denied } from "@/app/ui/denied";
import { pageData } from "@/server/auth/page-ctx";
import { listProducts } from "@/server/catalog/catalog";
import { listBrands, listCategories, listUoms } from "@/server/catalog/taxonomy";
import { stockSummary } from "@/server/inventory/queries";
import { createProductAction } from "./actions";

export const metadata: Metadata = { title: "Products" };

const STATUSES = ["draft", "active", "inactive", "discontinued", "archived"] as const;
const PER_PAGE = 50;

export default async function ProductsPage({ searchParams }: PageProps<"/products">) {
  const sp = await searchParams;
  const one = (k: string) => (typeof sp[k] === "string" && sp[k] ? (sp[k] as string) : undefined);
  const page = Math.max(1, Number(one("page") ?? 1) || 1);
  const status = STATUSES.find((s) => s === one("status")) as VariantStatus | undefined;

  const res = await pageData(async (ctx) => {
    const canCreate = ctx.permissions.has("products.create");
    const [list, categories, brands, uoms] = await Promise.all([
      listProducts(ctx, { page, perPage: PER_PAGE, q: one("q"), categoryId: one("categoryId"), brandId: one("brandId"), status }),
      listCategories(ctx), listBrands(ctx), canCreate ? listUoms(ctx) : [],
    ]);
    const variantIds = list.items.flatMap((p) => p.variants.map((v) => v.id));
    const stock = ctx.permissions.has("inventory.view") && variantIds.length ? await stockSummary(ctx, variantIds) : null;
    return { list, categories, brands, uoms, stock, canCreate, canManageTaxonomy: ctx.permissions.has("categories.manage") || ctx.permissions.has("brands.manage") };
  });
  if ("denied" in res) return <Denied message={res.denied} />;
  const { list, categories, brands, uoms, stock, canCreate, canManageTaxonomy } = res.data;
  const pages = Math.max(1, Math.ceil(list.total / PER_PAGE));
  const qs = (p: number) => `?${new URLSearchParams({ ...(Object.fromEntries(Object.entries(sp).filter(([, v]) => typeof v === "string")) as Record<string, string>), page: String(p) })}`;

  return (
    <div className="flex max-w-6xl flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="h1">Products</h1>
        {canManageTaxonomy && (
          <div className="flex gap-3 text-sm">
            <Link href="/products/categories" className="link">Categories</Link>
            <Link href="/products/brands" className="link">Brands &amp; units</Link>
          </div>
        )}
      </div>

      <form className="card grid gap-3 sm:grid-cols-5" role="search">
        <label className="label sm:col-span-2">Search<input name="q" defaultValue={one("q")} placeholder="Name, SKU or barcode" className="input" /></label>
        <label className="label">
          Category
          <select name="categoryId" defaultValue={one("categoryId") ?? ""} className="input">
            <option value="">All</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{"  ".repeat(c.depth - 1)}{c.name}</option>)}
          </select>
        </label>
        <label className="label">
          Brand
          <select name="brandId" defaultValue={one("brandId") ?? ""} className="input">
            <option value="">All</option>
            {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </label>
        <label className="label">
          Status
          <select name="status" defaultValue={status ?? ""} className="input">
            <option value="">All but archived</option>
            {STATUSES.map((s) => <option key={s}>{s}</option>)}
          </select>
        </label>
        <div className="sm:col-span-5"><button className="btn">Filter</button></div>
      </form>

      <div className="card overflow-x-auto p-0">
        <table className="table">
          <thead>
            <tr><th>SKU</th><th>Name</th><th>Brand / category</th>{stock && <th className="text-right">Available</th>}<th>Status</th></tr>
          </thead>
          <tbody>
            {list.items.length === 0 && (
              <tr><td colSpan={5} className="text-muted">No products match.{canCreate && " Create one below."}</td></tr>
            )}
            {list.items.map((p) => {
              const rows = stock?.filter((s) => p.variants.some((v) => v.id === s.variantId)) ?? [];
              const available = rows.reduce((s, r) => s + r.available, 0);
              const low = rows.some((r) => r.belowReorder);
              return (
                <tr key={p.id}>
                  <td className="font-mono text-xs">
                    {p.variants.slice(0, 3).map((v) => <div key={v.id}>{v.sku}</div>)}
                    {p.variants.length > 3 && <div className="text-muted">+{p.variants.length - 3} more</div>}
                  </td>
                  <td><Link href={`/products/${p.id}`} className="link">{p.name}</Link></td>
                  <td className="text-muted">{[p.brand?.name, p.category?.path.slice(1, -1).replaceAll("/", " › ")].filter(Boolean).join(" · ") || "—"}</td>
                  {stock && (
                    <td className="text-right tabular-nums">
                      {available.toLocaleString()}
                      {low && <span className="ml-2 rounded bg-amber-100 px-1.5 text-xs text-amber-900">reorder</span>}
                    </td>
                  )}
                  <td>{p.status}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {pages > 1 && (
        <nav aria-label="Pages" className="flex items-center gap-3 text-sm">
          {page > 1 && <Link href={qs(page - 1)} className="link">← Previous</Link>}
          <span className="text-muted">Page {page} of {pages} · {list.total} products</span>
          {page < pages && <Link href={qs(page + 1)} className="link">Next →</Link>}
        </nav>
      )}

      {canCreate && (
        <section className="card">
          <h2 className="mb-3 font-semibold">New product</h2>
          <ActionForm action={createProductAction} submit="Create product">
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="label sm:col-span-2">Name<input name="name" required minLength={2} maxLength={200} className="input" /></label>
              <label className="label">
                Type
                <select name="type" className="input">
                  <option value="simple">Simple (one SKU)</option>
                  <option value="variant_parent">With variants (size/colour…)</option>
                </select>
              </label>
              <label className="label">SKU<input name="sku" required pattern="[A-Za-z0-9][A-Za-z0-9_\-]{2,39}" className="input font-mono uppercase" /></label>
              <label className="label">Barcode<input name="barcode" maxLength={48} className="input font-mono" /></label>
              <label className="label">First variant attributes<input name="attributes" placeholder="size=M, color=Red" className="input" /></label>
              <label className="label">
                Category
                <select name="categoryId" className="input">
                  <option value="">—</option>
                  {categories.map((c) => <option key={c.id} value={c.id}>{"  ".repeat(c.depth - 1)}{c.name}</option>)}
                </select>
              </label>
              <label className="label">
                Brand
                <select name="brandId" className="input">
                  <option value="">—</option>
                  {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </label>
              <label className="label">
                Base unit
                <select name="baseUom" defaultValue="each" className="input">
                  {uoms.map((u) => <option key={u.code} value={u.code}>{u.name} ({u.code})</option>)}
                </select>
              </label>
              <label className="label">Sell price<input name="sellPrice" type="number" min={0} step="0.0001" className="input" /></label>
              <label className="label">Cost price (reference)<input name="costPrice" type="number" min={0} step="0.0001" className="input" /></label>
              <label className="label">
                Start as
                <select name="status" className="input"><option value="active">Active</option><option value="draft">Draft</option></select>
              </label>
            </div>
            <fieldset className="flex flex-wrap gap-4 text-sm">
              <legend className="mb-1 text-sm font-medium">Tracking (fixed once stock moves)</legend>
              <label className="flex items-center gap-2"><input type="checkbox" name="requiresBatch" /> Batches</label>
              <label className="flex items-center gap-2"><input type="checkbox" name="requiresExpiry" /> Expiry dates</label>
              <label className="flex items-center gap-2"><input type="checkbox" name="isSerialized" /> Serial numbers</label>
              <label className="flex items-center gap-2"><input type="checkbox" name="requiresInspection" /> Inspect on receipt</label>
            </fieldset>
          </ActionForm>
        </section>
      )}
    </div>
  );
}
