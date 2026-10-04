import { pageCtx } from "@/server/auth/page-ctx";
import { db } from "@/server/db";

export default async function HomePage() {
  const ctx = await pageCtx();
  const [roles, warehouses] = await Promise.all([
    db.userRole.findMany({ where: { userId: ctx.userId }, select: { role: { select: { name: true } } } }),
    db.warehouse.findMany({
      where: { companyId: ctx.companyId, ...(ctx.warehouseIds === "all" ? {} : { id: { in: ctx.warehouseIds } }) },
      select: { id: true, code: true, name: true }, orderBy: { code: "asc" },
    }),
  ]);
  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <h1 className="h1">Welcome</h1>
      <div className="card text-sm">
        <p><span className="text-muted">Roles:</span> {roles.map((r) => r.role.name).join(", ") || "none"}</p>
        <p className="mt-1">
          <span className="text-muted">Warehouses:</span>{" "}
          {ctx.warehouseIds === "all" ? "all" : ""} {warehouses.map((w) => `${w.code} (${w.name})`).join(", ") || "none assigned"}
        </p>
        <p className="mt-1"><span className="text-muted">Permissions:</span> {ctx.permissions.size}</p>
      </div>
    </div>
  );
}
