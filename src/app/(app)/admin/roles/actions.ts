"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { PERMISSIONS } from "@/server/auth/grants";
import { pageCtx, runAction, type ActionState } from "@/server/auth/page-ctx";
import { AppError } from "@/server/core/errors";
import { execute } from "@/server/core/execute";
import { createRole, setRoleGrants } from "@/server/users/roles";

export async function createRoleAction(_: ActionState, form: FormData): Promise<ActionState> {
  const input = z.object({
    code: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/, "lower_snake_case"),
    name: z.string().trim().min(1).max(100),
  }).safeParse({ code: form.get("code"), name: form.get("name") });
  if (!input.success) return { error: "Code must be lower_snake_case; name is required" };
  const ctx = await pageCtx();
  let id: string;
  try {
    const role = await execute(ctx, { scope: "roles.create" }, (tx) => createRole(tx, ctx, { ...input.data, grants: [] }));
    id = (role as { id: string }).id;
  } catch (e) {
    if (e instanceof AppError) return { error: e.message };
    throw e;
  }
  redirect(`/admin/roles/${id}`);
}

// The matrix form posts `grant=<code>` checkboxes and `limit:<code>` amounts.
export async function saveRoleAction(roleId: string, _: ActionState, form: FormData): Promise<ActionState> {
  const checked = new Set(form.getAll("grant").map(String));
  const grants = PERMISSIONS.filter((p) => checked.has(p)).map((code) => {
    const raw = String(form.get(`limit:${code}`) ?? "").trim();
    return { code, limitAmount: raw === "" ? null : raw };
  });
  if (grants.some((g) => g.limitAmount !== null && !/^\d{1,16}(\.\d{1,2})?$/.test(g.limitAmount))) {
    return { error: "Limits must be amounts ≥ 0 with up to 2 decimals" };
  }
  return runAction("roles.update", (tx, ctx) => setRoleGrants(tx, ctx, {
    roleId,
    version: Number(form.get("version")),
    name: String(form.get("name") ?? "").trim() || undefined,
    allWarehouses: form.get("allWarehouses") === "on",
    requires2fa: form.get("requires2fa") === "on",
    grants,
  }));
}
