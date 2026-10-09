import { z } from "zod";

// Doc 26: secrets come from env only. Validated once at boot (src/instrumentation.ts for
// the web server, src/worker/index.ts for the worker) so a misconfigured deploy fails fast
// instead of on the first request. Values are never logged — only the failing key names.
const Env = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    DATABASE_URL: z.url().refine((u) => u.startsWith("postgres"), "must be a postgres:// URL"),
    BETTER_AUTH_SECRET: z.string().min(32, "at least 32 characters"),
    BETTER_AUTH_URL: z.url(),
    CORS_ORIGINS: z.string().optional(), // comma-separated allowlist (doc 26)
  })
  .refine((e) => e.NODE_ENV !== "production" || !/change-me|dev-only|ci-only/.test(e.BETTER_AUTH_SECRET), {
    path: ["BETTER_AUTH_SECRET"], message: "placeholder secret in production",
  });

export function validateEnv(source: NodeJS.ProcessEnv = process.env) {
  const res = Env.safeParse(source);
  if (!res.success) {
    const keys = res.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment — ${keys}`);
  }
  return res.data;
}
