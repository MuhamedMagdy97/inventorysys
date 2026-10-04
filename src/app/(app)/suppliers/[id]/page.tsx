import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/app/ui/action-form";
import { Denied } from "@/app/ui/denied";
import { pageData } from "@/server/auth/page-ctx";
import { getSupplier } from "@/server/suppliers/suppliers";
import {
  addAddressAction, addContactAction, addDocumentAction, archiveChildAction, linkProductAction, supplierStatusAction, updateSupplierAction,
} from "../actions";

export const metadata: Metadata = { title: "Supplier" };

const NEXT: Record<string, string[]> = { active: ["inactive", "archived"], inactive: ["active", "archived"], archived: [] };

export default async function SupplierPage({ params }: PageProps<"/suppliers/[id]">) {
  const { id } = await params;
  const res = await pageData(async (ctx) => ({
    s: await getSupplier(ctx, id),
    canEdit: ctx.permissions.has("suppliers.update"),
    canArchive: ctx.permissions.has("suppliers.archive"),
  }));
  if ("denied" in res) return <Denied message={res.denied} />;
  const { s, canArchive } = res.data;
  const canEdit = res.data.canEdit && s.status !== "archived";
  const statuses = NEXT[s.status].filter((x) => x !== "archived" || canArchive);

  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <div>
        <Link href="/suppliers" className="link text-sm">← Suppliers</Link>
        <h1 className="h1 mt-1">{s.name}</h1>
        <p className="text-sm text-muted">{s.code} · {s.status} · {s.paymentTerms} · {s.currency}</p>
      </div>

      <section className="card">
        <h2 className="mb-3 font-semibold">Profile</h2>
        {canEdit ? (
          <ActionForm action={updateSupplierAction.bind(null, s.id)}>
            <input type="hidden" name="version" value={s.version} />
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="label sm:col-span-2">Name<input name="name" defaultValue={s.name} required minLength={2} className="input" /></label>
              <label className="label">Currency<input name="currency" defaultValue={s.currency} pattern="[A-Za-z]{3}" className="input uppercase" /></label>
              <label className="label">
                Payment terms
                <select name="paymentTerms" defaultValue={s.paymentTerms} className="input">{["net15", "net30", "net60", "prepaid", "cod"].map((t) => <option key={t}>{t}</option>)}</select>
              </label>
              <label className="label">Credit limit<input name="creditLimit" type="number" min={0} step="0.01" defaultValue={s.creditLimit?.toString() ?? ""} className="input" /></label>
              <label className="label">Lead time (days)<input name="leadTimeDays" type="number" min={0} defaultValue={s.leadTimeDays ?? ""} className="input" /></label>
              <label className="label">Tax ID<input name="taxId" defaultValue={s.taxId ?? ""} className="input" /></label>
              <label className="label">Receipt tolerance %<input name="receiptTolerancePct" type="number" min={0} max={100} step="0.01" defaultValue={s.receiptTolerancePct?.toString() ?? ""} placeholder="company default" className="input" /></label>
              <label className="label">Notes<input name="notes" defaultValue={s.notes ?? ""} className="input" /></label>
            </div>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="requiresInspection" defaultChecked={s.requiresInspection} /> Inspect everything received from this supplier</label>
          </ActionForm>
        ) : (
          <p className="text-sm">Credit limit {s.creditLimit?.toString() ?? "—"} · lead time {s.leadTimeDays ?? "—"} days · tax ID {s.taxId ?? "—"}</p>
        )}
      </section>

      {statuses.length > 0 && (res.data.canEdit || canArchive) && (
        <section className="card">
          <h2 className="mb-1 font-semibold">Status</h2>
          <p className="mb-3 text-sm text-muted">Inactive blocks new purchase orders until re-activated; archived is permanent.</p>
          <ActionForm action={supplierStatusAction.bind(null, s.id)} submit="Change status" className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="version" value={s.version} />
            <label className="label">Move from {s.status} to<select name="status" className="input">{statuses.map((x) => <option key={x}>{x}</option>)}</select></label>
          </ActionForm>
        </section>
      )}

      <div className="grid gap-6 md:grid-cols-2">
        <section className="card">
          <h2 className="mb-3 font-semibold">Contacts</h2>
          <ul className="mb-3 flex flex-col gap-2 text-sm">
            {s.contacts.length === 0 && <li className="text-muted">None yet.</li>}
            {s.contacts.map((c) => (
              <li key={c.id} className="flex items-start justify-between gap-2">
                <span>
                  <span className="font-medium">{c.name}</span>{c.isPrimary && <span className="ml-1 text-xs text-green-700">primary</span>}
                  <span className="block text-muted">{[c.role, c.email, c.phone].filter(Boolean).join(" · ")}</span>
                </span>
                {canEdit && <ActionForm action={archiveChildAction.bind(null, s.id, "contact", c.id)} submit="Remove"><span /></ActionForm>}
              </li>
            ))}
          </ul>
          {canEdit && (
            <ActionForm action={addContactAction.bind(null, s.id)} submit="Add contact">
              <div className="grid gap-2 sm:grid-cols-2">
                <input name="name" aria-label="Name" placeholder="Name" required className="input" />
                <input name="role" aria-label="Role" placeholder="Role" className="input" />
                <input name="email" aria-label="Email" type="email" placeholder="Email" className="input" />
                <input name="phone" aria-label="Phone" type="tel" placeholder="Phone" className="input" />
              </div>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="isPrimary" /> Primary contact</label>
            </ActionForm>
          )}
        </section>

        <section className="card">
          <h2 className="mb-3 font-semibold">Addresses</h2>
          <ul className="mb-3 flex flex-col gap-2 text-sm">
            {s.addresses.length === 0 && <li className="text-muted">None yet.</li>}
            {s.addresses.map((a) => (
              <li key={a.id} className="flex items-start justify-between gap-2">
                <span><span className="font-medium capitalize">{a.type}</span><span className="block text-muted">{[a.line1, a.line2, a.city, a.postalCode, a.country].filter(Boolean).join(", ")}</span></span>
                {canEdit && <ActionForm action={archiveChildAction.bind(null, s.id, "address", a.id)} submit="Remove"><span /></ActionForm>}
              </li>
            ))}
          </ul>
          {canEdit && (
            <ActionForm action={addAddressAction.bind(null, s.id)} submit="Add address">
              <div className="grid gap-2 sm:grid-cols-2">
                <select name="type" aria-label="Type" className="input"><option>primary</option><option>billing</option><option>shipping</option></select>
                <input name="line1" aria-label="Address line 1" placeholder="Address line 1" required className="input" />
                <input name="line2" aria-label="Address line 2" placeholder="Address line 2" className="input" />
                <input name="city" aria-label="City" placeholder="City" required className="input" />
                <input name="postalCode" aria-label="Postal code" placeholder="Postal code" className="input" />
                <input name="country" aria-label="Country" placeholder="Country" required className="input" />
              </div>
            </ActionForm>
          )}
        </section>
      </div>

      <section className="card">
        <h2 className="mb-3 font-semibold">Products</h2>
        <div className="overflow-x-auto">
          <table className="table mb-3">
            <thead><tr><th>SKU</th><th>Product</th><th>Supplier SKU</th><th className="text-right">Last price</th><th className="text-right">Min order</th><th>Lead days</th><th /></tr></thead>
            <tbody>
              {s.products.length === 0 && <tr><td colSpan={7} className="text-muted">No products linked.</td></tr>}
              {s.products.map((p) => (
                <tr key={p.variantId}>
                  <td className="font-mono text-xs">{p.variant.sku}</td>
                  <td><Link href={`/products/${p.variant.productId}`} className="link">{p.variant.product.name}{p.variant.name && ` — ${p.variant.name}`}</Link></td>
                  <td>{p.supplierSku ?? "—"}</td>
                  <td className="text-right tabular-nums">{p.lastPrice ? `${p.lastPrice} ${s.currency}` : "—"}</td>
                  <td className="text-right tabular-nums">{p.minOrderQty?.toString() ?? "—"}</td>
                  <td>{p.leadDays ?? "—"}</td>
                  <td>{p.isPreferred && <span className="text-xs text-green-700">preferred</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {canEdit && (
          <ActionForm action={linkProductAction.bind(null, s.id)} submit="Link / update" className="flex flex-wrap items-end gap-3">
            <label className="label">SKU<input name="sku" required className="input w-40 font-mono uppercase" /></label>
            <label className="label">Supplier SKU<input name="supplierSku" className="input w-36" /></label>
            <label className="label">Last price ({s.currency})<input name="lastPrice" type="number" min={0} step="0.0001" className="input w-28" /></label>
            <label className="label">Min order<input name="minOrderQty" type="number" min={0} step="any" className="input w-24" /></label>
            <label className="label">Lead days<input name="leadDays" type="number" min={0} className="input w-20" /></label>
            <label className="flex items-center gap-2 pb-2 text-sm"><input type="checkbox" name="isPreferred" /> Preferred</label>
          </ActionForm>
        )}
        <p className="mt-2 text-xs text-muted">Last price is for reference; purchase orders keep the price agreed on them.</p>
      </section>

      <section className="card">
        <h2 className="mb-3 font-semibold">Documents</h2>
        <ul className="mb-3 flex flex-col gap-1 text-sm">
          {s.documents.length === 0 && <li className="text-muted">None yet.</li>}
          {s.documents.map((d) => <li key={d.id}><a href={d.fileUrl} className="link" target="_blank" rel="noreferrer noopener">{d.type}</a> <span className="text-muted">· {d.uploadedAt.toLocaleDateString()}</span></li>)}
        </ul>
        {canEdit && (
          <ActionForm action={addDocumentAction.bind(null, s.id)} submit="Add document" className="flex flex-wrap items-end gap-3">
            <label className="label">Type<input name="type" placeholder="contract, certificate…" className="input w-44" /></label>
            <label className="label grow">Link (https)<input name="fileUrl" type="url" pattern="https://.*" required className="input" /></label>
          </ActionForm>
        )}
      </section>
    </div>
  );
}
