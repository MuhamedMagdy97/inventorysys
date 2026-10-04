import type { Metadata } from "next";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

export default function LoginPage() {
  return (
    <main className="flex flex-1 items-center justify-center p-4">
      <div className="card w-full max-w-sm">
        <h1 className="h1 mb-4">Sign in</h1>
        <LoginForm />
      </div>
    </main>
  );
}
