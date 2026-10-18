"use server";

import { runAction, type ActionState } from "@/server/auth/page-ctx";
import { createEndpoint, rotateSecret, setEndpointStatus, updateEndpoint, type EventType } from "@/server/webhooks/webhooks";

const fields = (form: FormData) => ({
  url: String(form.get("url") ?? ""),
  description: String(form.get("description") ?? ""),
  events: form.getAll("events").map(String) as EventType[],
});
const shownOnce = (r: { secret: string }) => `Signing secret (shown once — copy it now): ${r.secret}`;

export async function createWebhookAction(_: ActionState, form: FormData): Promise<ActionState> {
  return runAction("webhooks.create", (tx, ctx) => createEndpoint(tx, ctx, fields(form)), shownOnce);
}

export async function saveWebhookAction(id: string, _: ActionState, form: FormData): Promise<ActionState> {
  return runAction("webhooks.update", (tx, ctx) => updateEndpoint(tx, ctx, { id, version: Number(form.get("version")), ...fields(form) }));
}

export async function rotateWebhookAction(id: string, _: ActionState, form: FormData): Promise<ActionState> {
  return runAction("webhooks.rotate", (tx, ctx) => rotateSecret(tx, ctx, { id, version: Number(form.get("version")) }), shownOnce);
}

export async function toggleWebhookAction(id: string, _: ActionState, form: FormData): Promise<ActionState> {
  const active = form.get("active") === "true";
  return runAction("webhooks.status", (tx, ctx) => setEndpointStatus(tx, ctx, { id, version: Number(form.get("version")), active }), active ? "Enabled" : "Disabled");
}
