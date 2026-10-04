"use client";

import { useActionState } from "react";
import type { ActionState } from "@/server/auth/page-ctx";

// A <form> bound to a Server Action that returns ActionState; shows the result inline.
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
  const [state, run, pending] = useActionState(action, null);
  return (
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
  );
}
