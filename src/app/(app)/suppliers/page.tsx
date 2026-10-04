import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/app/ui/action-form";
import { Denied } from "@/app/ui/denied";
import { pageData } from "@/server/auth/page-ctx";
import { db } from "@/server/db";
import { listSuppliers } from "@/server/suppliers/suppliers";
import { createSupplierAction } from "./actions";

export const metadata: Metadata = { title: "Suppliers" };

export default async function SuppliersPage({ searchParams }: PageProps<"/suppliers">) {
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q : undefined;
  const status = sp.status === "inactive" || sp.status === "archived" ? sp.status : undefined;
  const res = await pageData(async (ctx) => {
    const [list, company] = await Promise.all([
      listSuppliers(ctx, { page: 1, perPage: 200, q, status }), // ponytail: one page; paginate when a company passes 200 suppliers
      db.company.findUniqueOrThrow({ where: { id: ctx.companyId }, select: { currency: true } }),
    ]);
    return { list, currency: company.currency, canCreate: ctx.permissions.has("suppliers.create") };
  });
  if ("denied" in res) return <Denied message={res.denied} />;
  const { list, currency, canCreate } = res.data;
  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <h1 className="h1">Suppliers</h1>
      <form className="flex flex-wrap items-end gap-3" role="search">
        <label className="label">Search<input name="q" defaultValue={q} placeholder="Name or code" className="input" /></label>
        <label className="label">
          Status
          <select name="status" defaultValue={status ?? ""} className="input">
            <option value="">Active</option><option value="inactive">Inactive</option><option value="archived">Archived</option>
          </select>
        </label>
        <button className="btn">Filter</button>
      </form>
      <div className="card overflow-x-auto p-0">
        <table className="table">
          <thead><tr><th>Code</th><th>Name</th><th>Primary contact</th><th>Terms</th><th className="text-right">Products</th><th>Status</th></tr></thead>
          <tbody>
            {list.items.length === 0 && <tr><td colSpan={6} className="text-muted">No suppliers.{canCreate && " Add one below."}</td></tr>}
            {list.items.map((s) => (
              <tr key={s.id}>
                <td className="font-mono text-xs">{s.code}</td>
                <td><Link href={`/suppliers/${s.id}`} className="link">{s.name}</Link></td>
                <td>{s.contacts[0] ? `${s.contacts[0].name}${s.contacts[0].email ? ` · ${s.contacts[0].email}` : ""}` : "—"}</td>
                <td>{s.paymentTerms} · {s.currency}</td>
                <td className="text-right tabular-nums">{s._count.products}</td>
                <td>{s.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {canCreate && (
        <section className="card">
          <h2 className="mb-3 font-semibold">New supplier</h2>
          <ActionForm action={createSupplierAction} submit="Create supplier">
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="label sm:col-span-2">Name<input name="name" required minLength={2} maxLength={200} className="input" /></label>
              <label className="label">Currency<input name="currency" defaultValue={currency} pattern="[A-Za-z]{3}" required className="input uppercase" /></label>
              <label className="label">
                Payment terms
                <select name="paymentTerms" defaultValue="net30" className="input">
                  {["net15", "net30", "net60", "prepaid", "cod"].map((t) => <option key={t}>{t}</option>)}
                </select>
              </label>
              <label className="label">Tax ID<input name="taxId" className="input" /></label>
              <label className="label">Lead time (days)<input name="leadTimeDays" type="number" min={0} className="input" /></label>
            </div>
            <p className="text-xs text-muted">Add at least one contact and one address before its first purchase order is approved.</p>
          </ActionForm>
        </section>
      )}
    </div>
  );
}
