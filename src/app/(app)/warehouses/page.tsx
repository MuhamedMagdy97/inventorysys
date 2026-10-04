import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/app/ui/action-form";
import { Denied } from "@/app/ui/denied";
import { pageData } from "@/server/auth/page-ctx";
import { listWarehouseCards } from "@/server/warehouses/warehouses";
import { createWarehouseAction } from "./actions";

export const metadata: Metadata = { title: "Warehouses" };

export default async function WarehousesPage() {
  const res = await pageData(async (ctx) => ({ warehouses: await listWarehouseCards(ctx), canCreate: ctx.permissions.has("warehouses.create") }));
  if ("denied" in res) return <Denied message={res.denied} />;
  const { warehouses, canCreate } = res.data;
  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <h1 className="h1">Warehouses</h1>
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {warehouses.length === 0 && <li className="text-sm text-muted">No warehouses you can see.</li>}
        {warehouses.map((w) => (
          <li key={w.id}>
            <Link href={`/warehouses/${w.id}`} className={`card block hover:border-accent ${w.status !== "active" ? "opacity-60" : ""}`}>
              <span className="font-mono text-xs text-muted">{w.code}</span>
              <span className="block font-semibold">{w.name}</span>
              <span className="mt-2 block text-sm text-muted">
                {w._count.bins} bins · {w._count.userWarehouses} staff{w.manager && ` · manager ${w.manager.name}`}{w.status !== "active" && ` · ${w.status}`}
              </span>
            </Link>
          </li>
        ))}
      </ul>
      {canCreate && (
        <section className="card">
          <h2 className="mb-1 font-semibold">New warehouse</h2>
          <p className="mb-3 text-sm text-muted">Comes with MAIN (sellable), RECV (receiving), QUAR (quarantine) and DMG (damaged) bins.</p>
          <ActionForm action={createWarehouseAction} submit="Create warehouse">
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="label">Code<input name="code" required placeholder="WH-DXB-01" pattern="[A-Za-z0-9][A-Za-z0-9_\-]{0,29}" className="input font-mono uppercase" /></label>
              <label className="label sm:col-span-2">Name<input name="name" required maxLength={100} className="input" /></label>
              <label className="label sm:col-span-3">Address<input name="address" maxLength={500} className="input" /></label>
            </div>
          </ActionForm>
        </section>
      )}
    </div>
  );
}
