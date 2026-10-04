import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/server/auth/auth";
import { SetupForm } from "./setup-form";

export const metadata: Metadata = { title: "Set up two-factor authentication" };

// Reachable with a session even when the role's 2FA requirement blocks the app (doc 02 §6).
export default async function Setup2faPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/login");
  if (session.user.twoFactorEnabled) redirect("/");
  return (
    <main className="flex flex-1 items-center justify-center p-4">
      <div className="card w-full max-w-md">
        <h1 className="h1">Two-factor authentication</h1>
        <p className="mb-4 mt-1 text-sm text-muted">Required for your role before you can continue.</p>
        <SetupForm />
      </div>
    </main>
  );
}
