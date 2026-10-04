"use server";

import { APIError } from "better-auth/api";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/server/auth/auth";

export type LoginState = { step: "password" | "totp"; error?: string };

const message = (e: unknown) => (e instanceof APIError ? e.body?.message ?? e.message : null);

// Better Auth sets the session (or the pending-2FA) cookie via the nextCookies plugin.
export async function signInAction(_: LoginState, form: FormData): Promise<LoginState> {
  try {
    const res = await auth.api.signInEmail({
      body: { email: String(form.get("email") ?? "").toLowerCase(), password: String(form.get("password") ?? "") },
      headers: await headers(),
    });
    if ("twoFactorRedirect" in res && res.twoFactorRedirect) return { step: "totp" };
  } catch (e) {
    const m = message(e);
    if (m) return { step: "password", error: m };
    throw e;
  }
  redirect("/");
}

export async function verifyTotpAction(_: LoginState, form: FormData): Promise<LoginState> {
  try {
    await auth.api.verifyTOTP({ body: { code: String(form.get("code") ?? "") }, headers: await headers() });
  } catch (e) {
    const m = message(e);
    if (m) return { step: "totp", error: m };
    throw e;
  }
  redirect("/");
}

export async function signOutAction() {
  await auth.api.signOut({ headers: await headers() });
  redirect("/login");
}
