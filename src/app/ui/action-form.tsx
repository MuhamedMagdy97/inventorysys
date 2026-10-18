"use client";

import { startTransition, useActionState, useEffect, useRef, useState } from "react";
import type { ActionState } from "@/server/auth/page-ctx";

// A <form> bound to a Server Action that returns ActionState; shows the result inline.
// Every page's mutations go through here, so the doc 26 step-up dialog lives here too:
// on `stepUp`, ask for the password (+ TOTP), re-verify, then resubmit the same form data.
export function ActionForm({
  action,
  children,
  submit = "Save",
  className = "flex flex-col gap-3",
}: {
  action: (prev: ActionState, form: FormData) => Promise<ActionState>;
  children: React.ReactNode;
  submit?: string;
  className?: string;
}) {
  const last = useRef<FormData | null>(null);
  const [state, run, pending] = useActionState((prev: ActionState, f: FormData) => {
    last.current = f;
    return action(prev, f);
  }, null);
  const [dismissed, setDismissed] = useState<number | undefined>();
  const askStepUp = state?.stepUp && dismissed !== state.at;
  return (
    <>
      <form action={run} className={className}>
        {children}
        <div className="flex items-center gap-3">
          <button type="submit" disabled={pending} className="btn-primary">
            {pending ? "Working…" : submit}
          </button>
          {state?.error && <p role="alert" className="text-sm text-red-600">{state.error}</p>}
          {state?.ok && <p role="status" className="text-sm text-green-700">{state.ok}</p>}
        </div>
      </form>
      {askStepUp && (
        <StepUpDialog
          totp={state.stepUp!.totp}
          onClose={(verified) => {
            setDismissed(state.at);
            if (verified && last.current) startTransition(() => run(last.current!));
          }}
        />
      )}
    </>
  );
}

function StepUpDialog({ totp, onClose }: { totp: boolean; onClose: (verified: boolean) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => ref.current?.showModal(), []);

  async function verify(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    const res = await fetch("/api/step-up", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: f.get("password"), code: totp ? f.get("code") : undefined }),
    }).catch(() => null);
    setBusy(false);
    if (res?.ok) return onClose(true);
    const body = await res?.json().catch(() => null);
    setError(body?.message ?? "Could not verify. Try again.");
  }

  return (
    <dialog ref={ref} onCancel={() => onClose(false)} className="card m-auto w-full max-w-sm backdrop:bg-black/40">
      <form onSubmit={verify} className="flex flex-col gap-3">
        <h2 className="h1">Please confirm it&apos;s you</h2>
        <p className="text-sm text-muted">This action needs a recent sign-in. Enter your password to continue.</p>
        <label className="label">
          Password
          <input name="password" type="password" autoComplete="current-password" required autoFocus className="input" />
        </label>
        {totp && (
          <label className="label">
            Authenticator code
            <input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" required className="input" />
          </label>
        )}
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        <div className="flex gap-3">
          <button className="btn-primary" disabled={busy}>{busy ? "Checking…" : "Confirm"}</button>
          <button type="button" className="btn" onClick={() => onClose(false)}>Cancel</button>
        </div>
      </form>
    </dialog>
  );
}
