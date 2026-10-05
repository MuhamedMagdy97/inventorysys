import type { Ctx } from "@/server/core/ctx";
import type { Tx } from "@/server/db";

// Doc 17 N-01/N-03: advisory rows, written in the caller's transaction (so a rolled-back
// action never notifies). Delivery (center, email, digests) arrives in Part 9.
export function notify(
  tx: Tx,
  ctx: Ctx,
  n: { type: string; entityType: string; entityId: string; message: string; userId?: string | null; warehouseId?: string | null; link?: string },
) {
  return tx.notification.create({
    data: {
      companyId: ctx.companyId, actorId: ctx.userId, type: n.type, entityType: n.entityType, entityId: n.entityId,
      message: n.message, userId: n.userId ?? null, warehouseId: n.warehouseId ?? null, link: n.link ?? null,
    },
  });
}
