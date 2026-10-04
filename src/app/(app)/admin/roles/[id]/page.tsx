import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/app/ui/action-form";
import { PERMISSIONS, WAREHOUSE_SCOPED } from "@/server/auth/grants";
import { Denied } from "@/app/ui/denied";
import { pageData } from "@/server/auth/page-ctx";
import { listRoles } from "@/server/users/roles";
import { saveRoleAction } from "../actions";

export const metadata: Metadata = { title: "Role" };

// Permission-matrix editor (doc 25): grants grouped by resource; approve grants take a limit.
export default async function RolePage({ params }: PageProps<"/admin/roles/[id]">) {
  const { id } = await params;
  const res = await pageData(listRoles);
  if ("denied" in res) return <Denied message={res.denied} />;
  const role = res.data.find((r) => r.id === id);
  if (!role) notFound();
  const held = new Map(role.permissions.map((p) => [p.permissionCode, p.limitAmount?.toString() ?? ""]));
  const groups = Object.entries(Object.groupBy(PERMISSIONS, (p) => p.split(".")[0]));

  return (
    <div className="flex max-w-5xl flex-col gap-4">
      <div>
        <Link href="/admin/roles" className="link text-sm">← Roles</Link>
        <h1 className="h1 mt-1">{role.name} <span className="font-mono text-sm text-muted">{role.code}</span></h1>
        <p className="text-sm text-muted">Changes apply to every user with this role on their next request. You can only add grants you hold.</p>
      </div>
      <ActionForm action={saveRoleAction.bind(null, role.id)} submit="Save role">
        <input type="hidden" name="version" value={role.version} />
        <div className="card flex flex-col gap-3 sm:flex-row sm:items-end">
          <label className="label">Name<input name="name" defaultValue={role.name} className="input" /></label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="allWarehouses" defaultChecked={role.allWarehouses} /> All warehouses</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="requires2fa" defaultChecked={role.requires2fa} /> Requires 2FA</label>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          {groups.map(([resource, codes]) => (
            <fieldset key={resource} className="card flex flex-col gap-1 text-sm">
              <legend className="px-1 font-medium">{resource}</legend>
              {codes!.map((code) => (
                <div key={code} className="flex items-center justify-between gap-2">
                  <label className="flex items-center gap-2">
                    <input type="checkbox" name="grant" value={code} defaultChecked={held.has(code)} />
                    <span className="font-mono text-xs">{code.split(".")[1]}</span>
                    {WAREHOUSE_SCOPED.has(code) && <span className="text-xs text-muted">per warehouse</span>}
                  </label>
                  {code.includes("approve") && (
                    <input name={`limit:${code}`} defaultValue={held.get(code) ?? ""} inputMode="decimal" placeholder="no limit"
                      aria-label={`${code} limit`} className="input w-28 py-1" />
                  )}
                </div>
              ))}
            </fieldset>
          ))}
        </div>
      </ActionForm>
    </div>
  );
}
