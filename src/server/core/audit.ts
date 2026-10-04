import type { Prisma } from "@/generated/prisma/client";
import type { Tx } from "@/server/db";
import type { Ctx } from "./ctx";

// A-01: always called with the business write's tx, so audit and write commit together.
export async function writeAudit(
  tx: Tx,
  ctx: Pick<Ctx, "companyId" | "userId" | "requestId" | "channel">,
  entry: {
    action: string;
    entityType: string;
    entityId: string;
    warehouseId?: string | null;
    before?: unknown;
    after?: unknown;
    reason?: string | null;
    idempotencyKey?: string | null;
  },
) {
  return tx.auditLog.create({
    data: {
      companyId: ctx.companyId,
      actorId: ctx.userId,
      channel: ctx.channel ?? null,
      requestId: ctx.requestId,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      warehouseId: entry.warehouseId ?? null,
      before: json(entry.before),
      after: json(entry.after),
      reason: entry.reason ?? null,
      idempotencyKey: entry.idempotencyKey ?? null,
    },
    select: { id: true },
  });
}

// Decimals/Dates → plain JSON.
function json(v: unknown): Prisma.InputJsonValue | undefined {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}
