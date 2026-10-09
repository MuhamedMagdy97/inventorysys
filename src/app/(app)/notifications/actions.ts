"use server";

import { runAction, type ActionState } from "@/server/auth/page-ctx";
import { markRead, setPreferences } from "@/server/notifications/center";

export async function markAllReadAction(): Promise<ActionState> {
  return runAction("notifications.read", (tx, ctx) => markRead(tx, ctx, {}), "All marked as read");
}

export async function markOneReadAction(id: string): Promise<ActionState> {
  return runAction("notifications.read", (tx, ctx) => markRead(tx, ctx, { ids: [id] }), "Read");
}

export async function preferencesAction(_: ActionState, f: FormData): Promise<ActionState> {
  return runAction("notifications.preferences", (tx, ctx) => setPreferences(tx, ctx, { emailCategories: f.getAll("emailCategories").map(String) }), "Preferences saved");
}
