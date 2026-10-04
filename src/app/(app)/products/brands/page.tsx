import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/app/ui/action-form";
import { Denied } from "@/app/ui/denied";
import { pageData } from "@/server/auth/page-ctx";
import { listBrands, listUoms } from "@/server/catalog/taxonomy";
import { createBrandAction, createUomAction, updateBrandAction } from "../actions";

export const metadata: Metadata = { title: "Brands & units" };

export default async function BrandsPage() {
  const res = await pageData(async (ctx) => ({
    brands: await listBrands(ctx, { includeArchived: true }),
    uoms: await listUoms(ctx),
    canBrands: ctx.permissions.has("brands.manage"),
    canUom: ctx.permissions.has("uom.manage"),
  }));
  if ("denied" in res) return <Denied message={res.denied} />;
  const { brands, uoms, canBrands, canUom } = res.data;
  return (
    <div className="flex max-w-4xl flex-col gap-6">
      <div>
        <Link href="/products" className="link text-sm">← Products</Link>
        <h1 className="h1 mt-1">Brands</h1>
      </div>
      <div className="card overflow-x-auto p-0">
        <table className="table">
          <thead><tr><th>Brand</th><th className="text-right">Products</th>{canBrands && <th />}</tr></thead>
          <tbody>
            {brands.length === 0 && <tr><td colSpan={3} className="text-muted">No brands yet.</td></tr>}
            {brands.map((b) => (
              <tr key={b.id} className={b.archived ? "text-muted" : undefined}>
                <td>
                  {canBrands && !b.archived ? (
                    <ActionForm action={updateBrandAction.bind(null, b.id)} submit="Rename" className="flex gap-2">
                      <input type="hidden" name="version" value={b.version} />
                      <input name="name" aria-label="Brand name" defaultValue={b.name} required className="input w-56" />
                    </ActionForm>
                  ) : <>{b.name}{b.archived && " (archived)"}</>}
                </td>
                <td className="text-right tabular-nums">{b._count.products}</td>
                {canBrands && (
                  <td>
                    <ActionForm action={updateBrandAction.bind(null, b.id)} submit={b.archived ? "Re-activate" : "Archive"}>
                      <input type="hidden" name="version" value={b.version} />
                      <input type="hidden" name="archived" value={String(!b.archived)} />
                    </ActionForm>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {canBrands && (
        <section className="card">
          <h2 className="mb-3 font-semibold">New brand</h2>
          <ActionForm action={createBrandAction} submit="Create" className="flex flex-wrap items-end gap-3">
            <label className="label">Name<input name="name" required maxLength={100} className="input" /></label>
          </ActionForm>
        </section>
      )}

      <h2 className="h1">Units of measure</h2>
      <div className="card overflow-x-auto p-0">
        <table className="table">
          <thead><tr><th>Code</th><th>Name</th><th>Type</th></tr></thead>
          <tbody>{uoms.map((u) => <tr key={u.code}><td className="font-mono">{u.code}</td><td>{u.name}</td><td>{u.type}</td></tr>)}</tbody>
        </table>
      </div>
      {canUom && (
        <section className="card">
          <h2 className="mb-3 font-semibold">New unit</h2>
          <ActionForm action={createUomAction} submit="Create" className="flex flex-wrap items-end gap-3">
            <label className="label">Code<input name="code" required pattern="[a-z][a-z0-9_]{0,15}" className="input w-32 font-mono" /></label>
            <label className="label">Name<input name="name" required className="input" /></label>
            <label className="label">
              Type
              <select name="type" className="input">{["count", "weight", "volume", "length"].map((t) => <option key={t}>{t}</option>)}</select>
            </label>
          </ActionForm>
        </section>
      )}
    </div>
  );
}
