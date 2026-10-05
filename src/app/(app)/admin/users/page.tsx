import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/app/ui/action-form";
import { Denied } from "@/app/ui/denied";
import { pageData } from "@/server/auth/page-ctx";
import { listRoles } from "@/server/users/roles";
import { listUsers } from "@/server/users/users";
import { listWarehouses } from "@/server/warehouses/warehouses";
import { AccessFields } from "./access-fields";
import { createUserAction } from "./actions";

export const metadata: Metadata = { title: "Users" };

export default async function UsersPage() {
  const res = await pageData(async (ctx) => {
    const canManage = ctx.permissions.has("users.manage");
    const [users, roles, warehouses] = await Promise.all([
      listUsers(ctx), canManage ? listRoles(ctx) : [], canManage ? listWarehouses(ctx) : [],
    ]);
    return { users, roles, warehouses, canManage };
  });
  if ("denied" in res) return <Denied message={res.denied} />;
  const { users, roles, warehouses, canManage } = res.data;
  const now = new Date();
  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <h1 className="h1">Users</h1>
      <div className="card overflow-x-auto p-0">
        <table className="table">
          <thead><tr><th>Name</th><th>Email</th><th>Roles</th><th>Warehouses</th><th>Status</th></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>
                  <Link href={`/admin/users/${u.id}`} className="link">{u.name}</Link>
                  {u.isService && <span className="ml-1 text-xs text-muted">service</span>}
                </td>
                <td>{u.email}</td>
                <td>{u.roles.map((r) => r.role.name).join(", ")}</td>
                <td>{u.warehouses.map((w) => w.warehouse.code).join(", ")}</td>
                <td>
                  {u.status}
                  {u.lockedUntil && u.lockedUntil > now && <span className="ml-1 text-red-600">locked</span>}
                  {u.twoFactorEnabled && <span className="ml-1 text-xs text-muted">2FA</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {canManage && (
        <section className="card">
          <h2 className="mb-3 font-semibold">New user</h2>
          <ActionForm action={createUserAction} submit="Create user">
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="label">Name<input name="name" required className="input" /></label>
              <label className="label">Email<input name="email" type="email" required className="input" /></label>
              <label className="label">
                Initial password
                <input name="password" type="password" minLength={10} autoComplete="new-password" className="input" />
              </label>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="isService" /> Service user (sales-channel API key; cannot sign in, no password)
            </label>
            <label className="label max-w-xs">
              Channel (service users: what their keys sell as)
              <select name="salesChannel" defaultValue="api" className="input">
                <option value="pos">POS</option><option value="web">Web shop</option>
                <option value="marketplace">Marketplace</option><option value="api">Other API</option>
              </select>
            </label>
            <AccessFields roles={roles} warehouses={warehouses} />
          </ActionForm>
        </section>
      )}
    </div>
  );
}
