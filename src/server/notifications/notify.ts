import type { Ctx } from "@/server/core/ctx";
import type { Tx } from "@/server/db";

// Doc 17 N-01/N-03: advisory rows, written in the caller's transaction (so a rolled-back
// action never notifies). `userId` = one recipient; null = broadcast to everyone with
// access to `warehouseId` (company-wide when null) who holds `permission` (when set).
// Center: ./center.ts; email (instant / daily digest): ./jobs.ts.
export function notify(
  tx: Tx,
  ctx: Pick<Ctx, "companyId" | "userId">,
  n: {
    type: string; entityType: string; entityId: string; message: string;
    userId?: string | null; warehouseId?: string | null; link?: string; permission?: string;
  },
) {
  return tx.notification.create({
    data: {
      companyId: ctx.companyId, actorId: ctx.userId, type: n.type, entityType: n.entityType, entityId: n.entityId,
      message: n.message, userId: n.userId ?? null, warehouseId: n.warehouseId ?? null, link: n.link ?? null,
      permission: n.permission ?? null,
    },
  });
}

// Doc 17 §3: email categories (user opt-in, N-02) and their delivery mode (N-03).
export const CATEGORIES = {
  stock: { label: "Low stock, out of stock, expiring / expired batches", mode: "digest" },
  reservations: { label: "Reservation expiry", mode: "digest" },
  approvals: { label: "Approvals waiting, reminders, escalations", mode: "instant" },
  discrepancies: { label: "Discrepancies (transit variance, receiving, reconciler drift)", mode: "instant" },
  documents: { label: "Document updates (approved, rejected, shipped…)", mode: "instant" },
} as const;
export type Category = keyof typeof CATEGORIES;

export function categoryOf(type: string): Category {
  if (/^(stock|batch)\./.test(type)) return "stock";
  if (type.startsWith("reservation.")) return "reservations";
  if (type.startsWith("approval.")) return "approvals";
  if (/variance|discrepancy|drift|excess/.test(type)) return "discrepancies";
  return "documents";
}
