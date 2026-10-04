import { createHash } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { db, transaction, type Tx } from "@/server/db";
import { writeAudit } from "./audit";
import type { Ctx } from "./ctx";
import { AppError } from "./errors";

type Json = Prisma.JsonValue;

// Guard failures that A-06 wants audited as `transition.denied` (the business
// transaction rolled back, so this audit row is written on its own).
const DENIED = new Set(["version_conflict", "invalid_transition", "reservation_expired", "forbidden"]);

// Runs one mutating use case in a transaction.
// With an idempotency key (MV-02 layer 1 / INV-017): the first request stores its
// JSON response in the same transaction; a retry with the same key and body gets
// that exact response back without re-executing; a different body → `conflict`.
// The key row is inserted first, so a concurrent duplicate blocks on it and then
// replays the winner's response instead of running twice.
export async function execute(
  ctx: Ctx,
  opts: { scope: string; idempotencyKey?: string | null; request?: unknown; entity?: { type: string; id: string } },
  fn: (tx: Tx) => Promise<unknown>,
): Promise<Json> {
  try {
    return await transaction(async (tx) => {
      const key = opts.idempotencyKey;
      if (!key) return toJson(await fn(tx));

      const requestHash = createHash("sha256").update(`${opts.scope}\n${stableJson(opts.request ?? null)}`).digest("hex");
      const inserted = await tx.$executeRaw`
        INSERT INTO idempotency_record (company_id, key, scope, request_hash, response, created_at)
        VALUES (${ctx.companyId}, ${key}, ${opts.scope}, ${requestHash}, 'null'::jsonb, now())
        ON CONFLICT (company_id, key) DO NOTHING`;
      if (inserted === 0) {
        const rec = await tx.idempotencyRecord.findUniqueOrThrow({ where: { companyId_key: { companyId: ctx.companyId, key } } });
        if (rec.requestHash !== requestHash) {
          throw new AppError("conflict", "Idempotency-Key was already used for a different request");
        }
        await writeAudit(tx, ctx, { action: "dedup", entityType: "idempotency_key", entityId: key, idempotencyKey: key });
        return rec.response;
      }
      const response = toJson(await fn(tx));
      const saved = await tx.idempotencyRecord.update({
        where: { companyId_key: { companyId: ctx.companyId, key } },
        data: { response: response as Prisma.InputJsonValue },
      });
      return saved.response; // the stored jsonb, so first call and replays are byte-identical
    });
  } catch (e) {
    if (e instanceof AppError && DENIED.has(e.code)) {
      await writeAudit(db, ctx, {
        action: e.code === "forbidden" ? "access.denied" : "transition.denied",
        entityType: opts.entity?.type ?? opts.scope,
        entityId: opts.entity?.id ?? "-",
        reason: e.message,
        after: { code: e.code, details: e.details ?? null },
        idempotencyKey: opts.idempotencyKey ?? null,
      });
    }
    throw e;
  }
}

// Decimals → strings, Dates → ISO: the same shape whether fresh or replayed.
function toJson(v: unknown): Json {
  return v === undefined ? null : JSON.parse(JSON.stringify(v));
}

function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}
