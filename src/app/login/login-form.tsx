"use client";

import { useActionState } from "react";
import { signInAction, verifyTotpAction, type LoginState } from "./actions";

export function LoginForm() {
  const [pw, signIn, signingIn] = useActionState<LoginState, FormData>(signInAction, { step: "password" });
  const [totp, verify, verifying] = useActionState<LoginState, FormData>(verifyTotpAction, { step: "totp" });

  if (pw.step === "totp") {
    return (
      <form action={verify} className="flex flex-col gap-3">
        <label className="label">
          Authenticator code
          <input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" required autoFocus className="input" />
        </label>
        {totp.error && <p role="alert" className="text-sm text-red-600">{totp.error}</p>}
        <button className="btn-primary" disabled={verifying}>{verifying ? "Checking…" : "Verify"}</button>
      </form>
    );
  }
  return (
    <form action={signIn} className="flex flex-col gap-3">
      <label className="label">
        Email
        <input name="email" type="email" autoComplete="username" required autoFocus className="input" />
      </label>
      <label className="label">
        Password
        <input name="password" type="password" autoComplete="current-password" required className="input" />
      </label>
      {pw.error && <p role="alert" className="text-sm text-red-600">{pw.error}</p>}
      <button className="btn-primary" disabled={signingIn}>{signingIn ? "Signing in…" : "Sign in"}</button>
    </form>
  );
}
