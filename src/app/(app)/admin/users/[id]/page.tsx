import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/app/ui/action-form";
import { Denied } from "@/app/ui/denied";
import { pageData } from "@/server/auth/page-ctx";
import { listRoles } from "@/server/users/roles";
import { getUser } from "@/server/users/users";
import { listWarehouses } from "@/server/warehouses/warehouses";
import { AccessFields } from "../access-fields";
import { createKeyAction, unlockUserAction, updateUserAction } from "../actions";

export const metadata: Metadata = { title: "User" };

export default async function UserPage({ params }: PageProps<"/admin/users/[id]">) {
  const { id } = await params;
  const res = await pageData(async (ctx) => {
    const canManage = ctx.permissions.has("users.manage");
    const [user, roles, warehouses] = await Promise.all([
      getUser(ctx, id), canManage ? listRoles(ctx) : [], canManage ? listWarehouses(ctx) : [],
    ]);
    return { user, roles, warehouses, canManage };
  });
  if ("denied" in res) return <Denied message={res.denied} />;
  const { user, roles, warehouses, canManage } = res.data;
  const locked = user.lockedUntil && user.lockedUntil > new Date();
  return (
    <div className="flex max-w-4xl flex-col gap-6">
      <div>
        <Link href="/admin/users" className="link text-sm">← Users</Link>
        <h1 className="h1 mt-1">{user.name}</h1>
        <p className="text-sm text-muted">
          {user.email}{user.isService ? " · service user" : ""} · 2FA {user.twoFactorEnabled ? "on" : "off"} · {user.status}
        </p>
      </div>

      {canManage && (
        <section className="card">
          <h2 className="mb-3 font-semibold">Access</h2>
          <ActionForm action={updateUserAction.bind(null, user.id)}>
            <input type="hidden" name="version" value={user.version} />
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="label">Name<input name="name" defaultValue={user.name} required className="input" /></label>
              <label className="label">
                Status
                <select name="status" defaultValue={user.status} className="input">
                  <option value="active">Active</option>
                  <option value="disabled">Disabled (signs out everywhere)</option>
                </select>
              </label>
            </div>
            <AccessFields roles={roles} warehouses={warehouses}
              roleIds={user.roles.map((r) => r.roleId)} warehouseIds={user.warehouses.map((w) => w.warehouseId)} />
          </ActionForm>
        </section>
      )}

      {canManage && locked && (
        <section className="card">
          <h2 className="mb-2 font-semibold">Locked</h2>
          <p className="mb-3 text-sm text-muted">Too many failed sign-ins. Locked until {user.lockedUntil!.toLocaleString()}.</p>
          <ActionForm action={unlockUserAction.bind(null, user.id)} submit="Unlock now"><span /></ActionForm>
        </section>
      )}

      {canManage && user.isService && (
        <section className="card">
          <h2 className="mb-3 font-semibold">API key</h2>
          <ActionForm action={createKeyAction.bind(null, user.id)} submit="Create key">
            <label className="label">Key name<input name="name" placeholder="e.g. Web store" className="input" /></label>
          </ActionForm>
        </section>
      )}
    </div>
  );
}
