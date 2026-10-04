import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/app/ui/action-form";
import { Denied } from "@/app/ui/denied";
import { pageData } from "@/server/auth/page-ctx";
import { listRoles } from "@/server/users/roles";
import { createRoleAction } from "./actions";

export const metadata: Metadata = { title: "Roles" };

export default async function RolesPage() {
  const res = await pageData(listRoles);
  if ("denied" in res) return <Denied message={res.denied} />;
  const { data: roles, ctx } = res;
  return (
    <div className="flex max-w-4xl flex-col gap-6">
      <h1 className="h1">Roles</h1>
      <div className="card overflow-x-auto p-0">
        <table className="table">
          <thead><tr><th>Role</th><th>Code</th><th>Grants</th><th>Users</th><th>Scope</th></tr></thead>
          <tbody>
            {roles.map((r) => (
              <tr key={r.id}>
                <td><Link href={`/admin/roles/${r.id}`} className="link">{r.name}</Link>{r.requires2fa && <span className="ml-1 text-xs text-muted">2FA</span>}</td>
                <td className="font-mono text-xs">{r.code}</td>
                <td>{r.permissions.length}</td>
                <td>{r._count.users}</td>
                <td>{r.allWarehouses ? "all warehouses" : "assigned"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {ctx.permissions.has("roles.manage") && (
        <section className="card">
          <h2 className="mb-3 font-semibold">New role</h2>
          <ActionForm action={createRoleAction} submit="Create and edit grants" className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <label className="label">Code<input name="code" required pattern="[a-z][a-z0-9_]{1,40}" placeholder="night_shift" className="input" /></label>
            <label className="label">Name<input name="name" required className="input" /></label>
          </ActionForm>
        </section>
      )}
    </div>
  );
}
