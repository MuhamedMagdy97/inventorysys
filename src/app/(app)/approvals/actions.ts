"use server";

import { clearable } from "@/app/ui/form";
import { runAction, type ActionState } from "@/server/auth/page-ctx";
import { decide, type InboxItem } from "@/server/approvals/inbox";

// The rendered key makes a double-click replay (approving damage/variance posts stock).
export async function decideAction(
  item: { type: InboxItem["type"]; id: string; version: number | null }, key: string, _: ActionState, f: FormData,
): Promise<ActionState> {
  return runAction(`approvals.${item.type}`, (tx, ctx) => decide(tx, ctx, {
    ...item, approve: f.get("decision") !== "reject", comment: clearable(f, "comment"),
  }), "Decided", undefined, key);
}
