"use server";

import { APIError } from "better-auth/api";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/server/auth/auth";
import { writeAudit } from "@/server/core/audit";
import { db } from "@/server/db";

export type SetupState = { step: "password" | "verify"; secret?: string; uri?: string; backupCodes?: string[]; error?: string };

const message = (e: unknown) => (e instanceof APIError ? e.body?.message ?? e.message : null);

// Step 1: password → TOTP secret + backup codes (2FA isn't on until step 2 verifies a code).
export async function startSetup(_: SetupState, form: FormData): Promise<SetupState> {
  try {
    const res = await auth.api.enableTwoFactor({ body: { password: String(form.get("password") ?? ""), method: "totp" }, headers: await headers() });
    if (res.method !== "totp") throw new Error("expected a TOTP enrolment");
    const secret = new URL(res.totpURI).searchParams.get("secret") ?? undefined;
    return { step: "verify", secret, uri: res.totpURI, backupCodes: res.backupCodes };
  } catch (e) {
    const m = message(e);
    if (m) return { step: "password", error: m };
    throw e;
  }
}

export async function finishSetup(prev: SetupState, form: FormData): Promise<SetupState> {
  const h = await headers();
  // Read the session first: verifying rotates it, and a later getSession with the old
  // cookie would clear the new session cookie.
  const session = await auth.api.getSession({ headers: h });
  try {
    await auth.api.verifyTOTP({ body: { code: String(form.get("code") ?? "") }, headers: h });
  } catch (e) {
    const m = message(e);
    if (m) return { ...prev, error: m };
    throw e;
  }
  if (session) {
    const u = await db.user.findUniqueOrThrow({ where: { id: session.user.id } });
    await writeAudit(db, { companyId: u.companyId, userId: u.id, requestId: crypto.randomUUID(), channel: "web" }, {
      action: "2fa.enabled", entityType: "user", entityId: u.id, after: { twoFactorEnabled: true },
    });
  }
  redirect("/");
}
