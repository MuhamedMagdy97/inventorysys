import { db } from "@/server/db";
import { PART1_PERMISSIONS } from "@/server/seed";
import type { Ctx } from "./ctx";
import { AppError } from "./errors";

// ponytail: Part 1 has no auth. Until T2.4 builds ctx from the session, the API acts
// as the seeded "Demo Company" admin — and refuses to run in production at all.
export async function requestCtx(requestId: string): Promise<Ctx> {
  if (process.env.NODE_ENV === "production") throw new AppError("forbidden", "Authentication is not configured yet");
  const admin = await db.user.findFirst({
    where: { isSystem: false, company: { name: "Demo Company" } },
    orderBy: { createdAt: "asc" },
  });
  if (!admin) throw new AppError("forbidden", "No dev user — run `npm run db:seed`");
  return {
    companyId: admin.companyId,
    userId: admin.id,
    warehouseIds: "all",
    permissions: new Set(PART1_PERMISSIONS),
    requestId,
    channel: "api",
  };
}
