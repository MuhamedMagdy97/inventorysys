"use server";

import { z } from "zod";
import { pageCtx, runAction, type ActionState } from "@/server/auth/page-ctx";
import { AppError } from "@/server/core/errors";
import { createChannelKey, createUser, unlockUser, updateUserAccess } from "@/server/users/users";

const ids = (form: FormData, name: string) => form.getAll(name).map(String);

export async function createUserAction(_: ActionState, form: FormData): Promise<ActionState> {
  const input = z.object({
    name: z.string().trim().min(1).max(100),
    email: z.email(),
    password: z.string().max(200).optional(),
    isService: z.boolean(),
    salesChannel: z.enum(["pos", "web", "marketplace", "api"]).optional(),
  }).safeParse({
    name: form.get("name"), email: form.get("email"), password: form.get("password") || undefined, isService: form.get("isService") === "on",
    salesChannel: form.get("salesChannel") || undefined,
  });
  if (!input.success) return { error: "Check name, email and password" };
  return runAction("users.create", (tx, ctx) =>
    createUser(tx, ctx, { ...input.data, roleIds: ids(form, "roleIds"), warehouseIds: ids(form, "warehouseIds") }), "User created");
}

export async function updateUserAction(userId: string, _: ActionState, form: FormData): Promise<ActionState> {
  const input = z.object({
    name: z.string().trim().min(1).max(100),
    status: z.enum(["active", "disabled"]),
    version: z.coerce.number().int().min(0),
  }).safeParse({ name: form.get("name"), status: form.get("status"), version: form.get("version") });
  if (!input.success) return { error: "Invalid input" };
  return runAction("users.update", (tx, ctx) =>
    updateUserAccess(tx, ctx, { userId, ...input.data, roleIds: ids(form, "roleIds"), warehouseIds: ids(form, "warehouseIds") }));
}

export async function unlockUserAction(userId: string): Promise<ActionState> {
  return runAction("users.unlock", (tx, ctx) => unlockUser(tx, ctx, userId), "Unlocked");
}

export async function createKeyAction(userId: string, _: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await pageCtx();
  try {
    const { key } = await createChannelKey(ctx, { userId, name: String(form.get("name") || "channel") });
    return { ok: `API key (copy it now, it is not shown again): ${key}` };
  } catch (e) {
    if (e instanceof AppError) return { error: e.message };
    throw e;
  }
}
