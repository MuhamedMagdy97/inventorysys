"use server";

import { redirect } from "next/navigation";
import { refresh } from "next/cache";
import { str, version } from "@/app/ui/form";
import { pageCtx, runAction, type ActionState } from "@/server/auth/page-ctx";
import { AppError } from "@/server/core/errors";
import { cancelImport, confirmImport, previewImport, type ImportMode } from "@/server/imports/imports";

// Upload → preview (flow 20). previewImport/confirmImport run their own transactions
// (a failed confirm must still be recorded), so these don't go through runAction.
export async function uploadImportAction(_: ActionState, f: FormData): Promise<ActionState> {
  const ctx = await pageCtx();
  const file = f.get("file");
  let id: string;
  try {
    if (!(file instanceof File) || !file.size) throw new AppError("validation_error", "Choose a file");
    const type = str(f, "type") === "opening_balance" ? "opening_balance" : "products";
    const asOf = str(f, "asOf");
    const job = await previewImport(ctx, { type, fileName: file.name, bytes: new Uint8Array(await file.arrayBuffer()), warehouseId: str(f, "warehouseId") ?? null, asOf: asOf ? new Date(asOf) : null });
    id = job.id;
  } catch (e) {
    if (e instanceof AppError) return { error: e.message, at: Date.now() };
    throw e;
  }
  redirect(`/imports/${id}`);
}

export async function confirmImportAction(id: string, _: ActionState, f: FormData): Promise<ActionState> {
  const ctx = await pageCtx();
  try {
    await confirmImport(ctx, { id, version: version(f), mode: (str(f, "mode") as ImportMode | undefined) ?? "all_or_nothing" });
  } catch (e) {
    if (e instanceof AppError) {
      refresh();
      return { error: e.message, at: Date.now() };
    }
    throw e;
  }
  refresh();
  return { ok: "Imported", at: Date.now() };
}

export async function cancelImportAction(id: string, _: ActionState, f: FormData): Promise<ActionState> {
  return runAction("imports.cancel", (tx, ctx) => cancelImport(tx, ctx, { id, version: version(f) }), "Cancelled");
}
