// Runs once when the Next.js server starts: refuse to boot with a bad environment (doc 26).
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { validateEnv } = await import("@/server/env");
    validateEnv();
  }
}
