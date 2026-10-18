import { AppError } from "@/server/core/errors";
import { db } from "@/server/db";
import { auth, recordLoginAttempt } from "./auth";

// Doc 26 step-up re-verify: the signed-in user confirms their password (+ TOTP when enrolled)
// through Better Auth's own checks; success stamps `step_up_at` on THIS session only, which
// sessionCtx turns into a fresh `authAt`. Failures count toward the 5-fail lockout and are audited.
export async function stepUp(headers: Headers, input: { password: string; code?: string }): Promise<void> {
  const session = await auth.api.getSession({ headers });
  if (!session) throw new AppError("forbidden", "Not signed in", { reason: "unauthenticated" });
  const user = await db.user.findUniqueOrThrow({ where: { id: session.user.id } });
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    throw new AppError("forbidden", "Account locked. Try again later.", { reason: "locked" });
  }

  const passes = (p: Promise<unknown>) => p.then(() => true, () => false);
  let ok = await passes(auth.api.verifyPassword({ body: { password: input.password }, headers }));
  if (ok && user.twoFactorEnabled) ok = await passes(auth.api.verifyTOTP({ body: { code: input.code ?? "" }, headers }));

  await db.$transaction(async (tx) => {
    await recordLoginAttempt(tx, user, ok, headers.get("x-forwarded-for"), "auth.step_up");
    if (ok) await tx.session.update({ where: { id: session.session.id }, data: { stepUpAt: new Date() } });
  });
  if (!ok) throw new AppError("forbidden", user.twoFactorEnabled ? "Wrong password or code" : "Wrong password", { reason: "step_up_failed" });
}
