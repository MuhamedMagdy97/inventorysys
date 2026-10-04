import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/app/ui/action-form";
import { Denied } from "@/app/ui/denied";
import { pageData } from "@/server/auth/page-ctx";
import { inScope } from "@/server/core/ctx";
import { getWarehouse, listAssignableUsers } from "@/server/warehouses/warehouses";
import { binAction, createBinAction, staffAction, updateWarehouseAction, warehouseStatusAction } from "../actions";

export const metadata: Metadata = { title: "Warehouse" };

const NEXT: Record<string, string[]> = { active: ["inactive", "archived"], inactive: ["active", "archived"], archived: [] };

export default async function WarehousePage({ params }: PageProps<"/warehouses/[id]">) {
  const { id } = await params;
  const res = await pageData(async (ctx) => {
    const can = (g: string) => ctx.permissions.has(g);
    const w = await getWarehouse(ctx, id);
    const people = can("warehouses.assign_staff") || can("warehouses.update") ? await listAssignableUsers(ctx) : [];
    return {
      w, people,
      canEdit: can("warehouses.update"), canArchive: can("warehouses.archive"),
      canBins: can("locations.manage") && (can("warehouses.update") || inScope(ctx, id)),
      canStaff: can("warehouses.assign_staff") && inScope(ctx, id),
    };
  });
  if ("denied" in res) return <Denied message={res.denied} />;
  const { w, people, canArchive } = res.data;
  const live = w.status !== "archived";
  const canEdit = res.data.canEdit && live, canBins = res.data.canBins && live, canStaff = res.data.canStaff && live;
  const statuses = NEXT[w.status].filter((x) => x !== "archived" || canArchive);

  // Bin tree: zone › rack › shelf groups, in that order (doc 06 §1).
  const groups = new Map<string, typeof w.bins>();
  for (const b of w.bins) {
    const key = [b.zone, b.rack, b.shelf].filter(Boolean).join(" › ") || "No location";
    groups.set(key, [...(groups.get(key) ?? []), b]);
  }
  const staffIds = new Set(w.userWarehouses.map((u) => u.user.id));

  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <div>
        <Link href="/warehouses" className="link text-sm">← Warehouses</Link>
        <h1 className="h1 mt-1">{w.name}</h1>
        <p className="text-sm text-muted">{w.code} · {w.status}{w.manager && ` · manager ${w.manager.name}`}{w.address && ` · ${w.address}`}</p>
      </div>

      {canEdit && (
        <section className="card">
          <h2 className="mb-3 font-semibold">Details</h2>
          <ActionForm action={updateWarehouseAction.bind(null, w.id)}>
            <input type="hidden" name="version" value={w.version} />
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="label">Name<input name="name" defaultValue={w.name} required className="input" /></label>
              <label className="label">
                Manager
                <select name="managerUserId" defaultValue={w.managerUserId ?? ""} className="input">
                  <option value="">—</option>
                  {people.map((u) => <option key={u.id} value={u.id}>{u.name} · {u.email}</option>)}
                </select>
              </label>
              <label className="label sm:col-span-2">Address<input name="address" defaultValue={w.address ?? ""} className="input" /></label>
            </div>
          </ActionForm>
        </section>
      )}

      {statuses.length > 0 && (res.data.canEdit || canArchive) && (
        <section className="card">
          <h2 className="mb-1 font-semibold">Status</h2>
          <p className="mb-3 text-sm text-muted">Archiving needs the warehouse empty: no stock in any bucket and no open reservations.</p>
          <ActionForm action={warehouseStatusAction.bind(null, w.id)} submit="Change status" className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="version" value={w.version} />
            <label className="label">Move from {w.status} to<select name="status" className="input">{statuses.map((x) => <option key={x}>{x}</option>)}</select></label>
          </ActionForm>
        </section>
      )}

      <section className="card">
        <h2 className="mb-3 font-semibold">Bins</h2>
        <div className="flex flex-col gap-4">
          {[...groups.entries()].map(([loc, bins]) => (
            <div key={loc}>
              <h3 className="mb-1 text-sm font-medium text-muted">{loc}</h3>
              <div className="overflow-x-auto">
                <table className="table">
                  <thead>
                    <tr><th>Bin</th><th>Type</th>{w.binTotals && <><th className="text-right">On hand</th><th className="text-right">Blocked</th><th className="text-right">Damaged</th><th className="text-right">Expired</th></>}{canBins && <th />}</tr>
                  </thead>
                  <tbody>
                    {bins.map((b) => {
                      const t = w.binTotals?.[b.id];
                      return (
                        <tr key={b.id} className={b.archived ? "text-muted" : undefined}>
                          <td className="font-mono">
                            {b.code}
                            {b.isDefaultSellable && <span className="ml-1 font-sans text-xs text-green-700">default sellable</span>}
                            {b.isDefaultReceiving && <span className="ml-1 font-sans text-xs text-green-700">default receiving</span>}
                            {b.archived && <span className="ml-1 font-sans text-xs">archived</span>}
                          </td>
                          <td>{b.type}</td>
                          {w.binTotals && [t?.onHand, t?.blocked, t?.damaged, t?.expired].map((n, i) => <td key={i} className="text-right tabular-nums">{n?.toString() ?? "0"}</td>)}
                          {canBins && (
                            <td className="flex flex-wrap gap-2">
                              {!b.archived && (b.type === "sellable" || b.type === "receiving") && !(b.isDefaultSellable || b.isDefaultReceiving) && (
                                <ActionForm action={binAction.bind(null, b.id, b.type)} submit="Make default"><input type="hidden" name="version" value={b.version} /></ActionForm>
                              )}
                              {!(b.isDefaultSellable || b.isDefaultReceiving) && (
                                <ActionForm action={binAction.bind(null, b.id, b.archived ? "unarchive" : "archive")} submit={b.archived ? "Re-activate" : "Archive"}>
                                  <input type="hidden" name="version" value={b.version} />
                                </ActionForm>
                              )}
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
        {canBins && (
          <ActionForm action={createBinAction.bind(null, w.id)} submit="Add bin" className="mt-4 flex flex-wrap items-end gap-3">
            <label className="label">Code<input name="code" required pattern="[A-Za-z0-9][A-Za-z0-9_\-]{0,29}" className="input w-32 font-mono uppercase" /></label>
            <label className="label">
              Type
              <select name="type" className="input">{["sellable", "receiving", "quarantine", "damaged"].map((t) => <option key={t}>{t}</option>)}</select>
            </label>
            <label className="label">Zone<input name="zone" className="input w-24 uppercase" /></label>
            <label className="label">Rack<input name="rack" className="input w-24 uppercase" /></label>
            <label className="label">Shelf<input name="shelf" className="input w-24 uppercase" /></label>
          </ActionForm>
        )}
      </section>

      <section className="card">
        <h2 className="mb-3 font-semibold">Staff</h2>
        <ul className="mb-3 flex flex-col gap-2 text-sm">
          {w.userWarehouses.length === 0 && <li className="text-muted">Nobody is assigned. Users with all-warehouse roles still have access.</li>}
          {w.userWarehouses.map(({ user: u }) => (
            <li key={u.id} className="flex items-center justify-between gap-2">
              <span>{u.name} <span className="text-muted">· {u.email}{u.status !== "active" && ` · ${u.status}`}</span></span>
              {canStaff && w.managerUserId !== u.id && (
                <ActionForm action={staffAction.bind(null, w.id, false)} submit="Remove"><input type="hidden" name="userId" value={u.id} /></ActionForm>
              )}
            </li>
          ))}
        </ul>
        {canStaff && (
          <ActionForm action={staffAction.bind(null, w.id, true)} submit="Assign" className="flex flex-wrap items-end gap-3">
            <label className="label">
              Person
              <select name="userId" className="input">{people.filter((u) => !staffIds.has(u.id)).map((u) => <option key={u.id} value={u.id}>{u.name} · {u.email}</option>)}</select>
            </label>
          </ActionForm>
        )}
      </section>
    </div>
  );
}
