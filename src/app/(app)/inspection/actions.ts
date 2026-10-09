"use server";

import { clearable, str } from "@/app/ui/form";
import { runAction, type ActionState } from "@/server/auth/page-ctx";
import { AppError } from "@/server/core/errors";
import { db } from "@/server/db";
import { uploadEvidence } from "@/server/evidence/evidence";
import { DISPOSITIONS, inspectLot } from "@/server/inventory/inspection";

// One decision on a lot; attached photos/PDFs are uploaded in the same transaction, so a
// refused decision stores no orphan files. The rendered key makes a double submit replay.
export async function inspectAction(lotId: string, warehouseId: string, key: string, _: ActionState, f: FormData): Promise<ActionState> {
  return runAction("quarantine.inspect", async (tx, ctx) => {
    const files = f.getAll("evidence").filter((x): x is File => x instanceof File && x.size > 0);
    const evidenceIds = [];
    for (const file of files) {
      evidenceIds.push((await uploadEvidence(tx, ctx, { warehouseId, fileName: file.name, bytes: new Uint8Array(await file.arrayBuffer()) })).id);
    }
    const binCode = str(f, "bin");
    const bin = binCode ? await db.bin.findFirst({ where: { companyId: ctx.companyId, warehouseId, code: binCode } }) : null;
    if (binCode && !bin) throw new AppError("validation_error", `Unknown bin ${binCode}`, { field: "binId" });
    const disposition = DISPOSITIONS.find((d) => d === str(f, "disposition"));
    if (!disposition) throw new AppError("validation_error", "Choose a disposition", { field: "disposition" });
    return inspectLot(tx, ctx, {
      lotId, disposition, qty: str(f, "qty") ?? "0", binId: bin?.id ?? null, note: clearable(f, "note"),
      serials: (str(f, "serials") ?? "").split(/[\s,]+/).filter(Boolean), evidenceIds,
    });
  }, "Decided", undefined, key);
}
