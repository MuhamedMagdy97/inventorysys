import { apiKey } from "@better-auth/api-key";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { twoFactor } from "better-auth/plugins";
import { writeAudit } from "@/server/core/audit";
import { db } from "@/server/db";

// Doc 02 §6. Users are created by admins (src/server/users), never by self sign-up.
export const MAX_FAILED_LOGINS = 5;
export const LOCK_MINUTES = 15;

export const auth = betterAuth({
  appName: "Inventory",
  database: prismaAdapter(db, { provider: "postgresql" }),
  advanced: { database: { generateId: false } }, // Prisma's @default(uuid(7))
  emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: 10 },
  session: { expiresIn: 7 * 24 * 3600, updateAge: 24 * 3600 },
  // Sign-in / 2FA rate limits are src/proxy.ts (doc 26), one documented mechanism instead of two.
  rateLimit: { enabled: false },
  // Profile and keys are admin-managed through audited domain functions (src/server/users),
  // never self-service over HTTP. Server-side auth.api calls are unaffected.
  disabledPaths: ["/update-user", "/change-email", "/delete-user", "/api-key/create", "/api-key/update"],
  user: {
    additionalFields: {
      companyId: { type: "string", required: true, input: false },
    },
  },
  plugins: [
    twoFactor({ issuer: "Inventory" }),
    apiKey({ apiKeyHeaders: "x-api-key", enableMetadata: false, rateLimit: { enabled: false } }),
    nextCookies(), // must stay last
  ],
  hooks: {
    // Lockout: refuse before checking the password while locked (doc 02 §6).
    before: createAuthMiddleware(async (c) => {
      if (c.path !== "/sign-in/email") return;
      const user = await findLoginUser(c.body?.email);
      if (!user) return;
      if (user.status !== "active" || user.isService || user.isSystem) {
        throw new APIError("UNAUTHORIZED", { message: "Invalid email or password" });
      }
      if (user.lockedUntil && user.lockedUntil > new Date()) {
        throw new APIError("FORBIDDEN", { message: "Account locked. Try again later.", code: "ACCOUNT_LOCKED" });
      }
    }),
    after: createAuthMiddleware(async (c) => {
      if (c.path !== "/sign-in/email") return;
      const user = await findLoginUser(c.body?.email);
      if (!user) return; // unknown email: nothing to count, no company to audit under
      const failed = c.context.returned instanceof APIError;
      if (failed && c.context.returned instanceof APIError && c.context.returned.body?.code === "ACCOUNT_LOCKED") return;
      await db.$transaction(async (tx) => {
        const count = failed ? user.failedLoginCount + 1 : 0;
        const lock = failed && count >= MAX_FAILED_LOGINS;
        await tx.user.update({
          where: { id: user.id },
          data: { failedLoginCount: lock ? 0 : count, lockedUntil: lock ? new Date(Date.now() + LOCK_MINUTES * 60_000) : failed ? undefined : null },
        });
        const ctx = { companyId: user.companyId, userId: user.id, requestId: crypto.randomUUID(), channel: "web" as const };
        await writeAudit(tx, ctx, {
          action: lock ? "auth.locked" : failed ? "auth.login_failed" : "auth.login",
          entityType: "user",
          entityId: user.id,
          after: { failedCount: count, ip: c.request?.headers.get("x-forwarded-for") ?? null },
        });
      });
    }),
  },
});

function findLoginUser(email: unknown) {
  return typeof email === "string" ? db.user.findUnique({ where: { email: email.toLowerCase() } }) : null;
}
