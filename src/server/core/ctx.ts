import { AppError } from "./errors";

// Who is acting, for which company, in which warehouses. Built from the session
// in Part 2; tests and the worker build it directly.
export type Ctx = {
  companyId: string;
  userId: string; // actor_id; the system user for jobs
  warehouseIds: string[] | "all";
  permissions: ReadonlySet<string>;
  requestId: string;
  channel?: "web" | "api" | "mobile" | "scan" | "system";
};

// Permission (any of) + warehouse scope guard. Every domain function calls it itself.
// ponytail: no access.denied audit / limit_amount yet — Part 2 (T2.3) adds both here.
export function authorize(ctx: Ctx, permission: string | string[], warehouseId?: string): void {
  const any = Array.isArray(permission) ? permission : [permission];
  if (!any.some((p) => ctx.permissions.has(p))) {
    throw new AppError("forbidden", `Missing permission ${any.join(" | ")}`, { permission: any });
  }
  if (warehouseId && !inScope(ctx, warehouseId)) {
    throw new AppError("forbidden", "Warehouse out of scope", { warehouseId });
  }
}

export const inScope = (ctx: Ctx, warehouseId: string) =>
  ctx.warehouseIds === "all" || ctx.warehouseIds.includes(warehouseId);
