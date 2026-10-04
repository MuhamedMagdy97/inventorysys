import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { writeAudit } from "@/server/core/audit";
import { requirePermission, type Ctx } from "@/server/core/ctx";
import { db, type Tx } from "@/server/db";

// T2.6 company settings. Each key has a default here, so a missing row is never an error.
// Approval limits are per role grant (`limit_amount`, roles page), not here.
export const SettingsSchema = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/, "ISO 4217 code, e.g. USD"),
  timezone: z.string().refine((tz) => Intl.supportedValuesOf("timeZone").includes(tz) || tz === "UTC", "Unknown time zone"),
  reservationTtlSeconds: z.number().int().min(60).max(30 * 24 * 3600),
  receiptTolerancePct: z.number().min(0).max(100),
  barcodeAliasDays: z.number().int().min(0).max(365), // P-CAT-02
});
export type Settings = z.infer<typeof SettingsSchema>;

const DEFAULTS: Omit<Settings, "currency"> = {
  timezone: "UTC",
  reservationTtlSeconds: 48 * 3600,
  receiptTolerancePct: 0,
  barcodeAliasDays: 30,
};

// Internal read for domain code (no permission: callers already authorized their action).
export async function readSettings(tx: Tx | typeof db, companyId: string): Promise<Settings> {
  const [company, rows] = await Promise.all([
    tx.company.findUniqueOrThrow({ where: { id: companyId }, select: { currency: true } }),
    tx.setting.findMany({ where: { companyId } }),
  ]);
  return { ...DEFAULTS, ...Object.fromEntries(rows.map((r) => [r.key, r.value])), currency: company.currency } as Settings;
}

export async function getSettings(ctx: Ctx) {
  await requirePermission(ctx, "settings.manage");
  return readSettings(db, ctx.companyId);
}

export async function updateSettings(tx: Tx, ctx: Ctx, patch: Partial<Settings>) {
  await requirePermission(ctx, "settings.manage");
  const before = await readSettings(tx, ctx.companyId);
  const after = SettingsSchema.parse({ ...before, ...patch });
  const { currency, ...rest } = after;
  if (currency !== before.currency) await tx.company.update({ where: { id: ctx.companyId }, data: { currency } });
  for (const [key, value] of Object.entries(rest)) {
    await tx.setting.upsert({
      where: { companyId_key: { companyId: ctx.companyId, key } },
      create: { companyId: ctx.companyId, key, value: value as Prisma.InputJsonValue },
      update: { value: value as Prisma.InputJsonValue },
    });
  }
  await writeAudit(tx, ctx, { action: "update", entityType: "settings", entityId: ctx.companyId, before, after });
  return after;
}
