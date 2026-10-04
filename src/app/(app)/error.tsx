"use client";

// Unexpected failures (doc 25: error states carry a reference for support).
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="card max-w-lg">
      <h1 className="h1">Something went wrong</h1>
      <p className="mt-2 text-sm text-muted">Please try again. If it keeps happening, report reference {error.digest ?? "n/a"}.</p>
      <button onClick={reset} className="btn mt-3">Try again</button>
    </div>
  );
}
