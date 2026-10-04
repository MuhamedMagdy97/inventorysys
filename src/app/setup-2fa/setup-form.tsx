"use client";

import { useActionState } from "react";
import { finishSetup, startSetup, type SetupState } from "./actions";

export function SetupForm() {
  const [start, runStart, starting] = useActionState<SetupState, FormData>(startSetup, { step: "password" });
  const [finish, runFinish, finishing] = useActionState<SetupState, FormData>(finishSetup, { step: "verify" });

  if (start.step === "password") {
    return (
      <form action={runStart} className="flex flex-col gap-3">
        <label className="label">
          Confirm your password
          <input name="password" type="password" autoComplete="current-password" required autoFocus className="input" />
        </label>
        {start.error && <p role="alert" className="text-sm text-red-600">{start.error}</p>}
        <button className="btn-primary" disabled={starting}>{starting ? "Working…" : "Continue"}</button>
      </form>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <div className="text-sm">
        <p>Add this key to your authenticator app (Google Authenticator, 1Password, Authy…):</p>
        <code className="mt-2 block break-all rounded bg-background p-2 font-mono text-base tracking-wider">{start.secret}</code>
        <a href={start.uri} className="link mt-1 inline-block text-xs">Open in authenticator app</a>
      </div>
      <div className="text-sm">
        <p className="font-medium">Backup codes — store them somewhere safe. Each works once.</p>
        <ul className="mt-2 grid grid-cols-2 gap-1 font-mono">{start.backupCodes?.map((c) => <li key={c}>{c}</li>)}</ul>
      </div>
      <form action={runFinish} className="flex flex-col gap-3">
        <label className="label">
          6-digit code from the app
          <input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" required className="input" />
        </label>
        {finish.error && <p role="alert" className="text-sm text-red-600">{finish.error}</p>}
        <button className="btn-primary" disabled={finishing}>{finishing ? "Checking…" : "Turn on 2FA"}</button>
      </form>
    </div>
  );
}
