import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { refresh } from "next/cache";
import type { Ctx } from "@/server/core/ctx";
import { AppError } from "@/server/core/errors";
import { execute } from "@/server/core/execute";
import type { Tx } from "@/server/db";
import { sessionCtx } from "./session-ctx";

// Server Components / Server Actions: ctx from the session cookie, or send the user
// where they need to go (login, 2FA setup). Never trust the page for authorization:
// domain functions re-check permissions themselves.
export async function pageCtx(): Promise<Ctx> {
  try {
    return await sessionCtx(await headers(), crypto.randomUUID());
  } catch (e) {
    const reason = e instanceof AppError ? (e.details as { reason?: string } | undefined)?.reason : undefined;
    if (reason === "2fa_required") redirect("/setup-2fa");
    if (reason === "unauthenticated" || reason === "inactive") redirect("/login");
    throw e;
  }
}

export type ActionState = { ok?: string; error?: string; at?: number } | null;

// One mutating Server Action: session ctx → domain fn in a transaction (execute) →
// refresh the page. Domain errors come back as a message for <ActionForm>.
export async function runAction<T>(
  scope: string,
  fn: (tx: Tx, ctx: Ctx) => Promise<T>,
  ok = "Saved",
  redirectTo?: (result: T) => string, // e.g. to the record just created
): Promise<ActionState> {
  const ctx = await pageCtx();
  let result: T;
  try {
    result = (await execute(ctx, { scope }, (tx) => fn(tx, ctx))) as T;
  } catch (e) {
    if (e instanceof AppError) return { error: e.message, at: Date.now() };
    if (e && typeof e === "object" && "issues" in e) return { error: "Invalid input", at: Date.now() };
    throw e;
  }
  if (redirectTo) redirect(redirectTo(result));
  refresh();
  return { ok, at: Date.now() };
}

// Page data loader: domain `forbidden` → a 403 message the page renders; `not_found` → 404.
export async function pageData<T>(load: (ctx: Ctx) => Promise<T>): Promise<{ data: T; ctx: Ctx } | { denied: string }> {
  const ctx = await pageCtx();
  try {
    return { data: await load(ctx), ctx };
  } catch (e) {
    if (e instanceof AppError && e.code === "forbidden") return { denied: e.message };
    if (e instanceof AppError && e.code === "not_found") notFound();
    throw e;
  }
}
