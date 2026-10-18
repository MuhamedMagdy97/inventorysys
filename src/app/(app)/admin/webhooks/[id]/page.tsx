import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/app/ui/action-form";
import { Denied } from "@/app/ui/denied";
import { pageData } from "@/server/auth/page-ctx";
import { getEndpoint } from "@/server/webhooks/webhooks";
import { rotateWebhookAction, saveWebhookAction, toggleWebhookAction } from "../actions";
import { EndpointFields } from "../fields";

export const metadata: Metadata = { title: "Webhook" };

// Endpoint settings, secret rotation, enable/disable, and the delivery log (latest 50).
export default async function WebhookPage({ params }: PageProps<"/admin/webhooks/[id]">) {
  const { id } = await params;
  const res = await pageData((ctx) => getEndpoint(ctx, id));
  if ("denied" in res) return <Denied message={res.denied} />;
  const { endpoint: e, deliveries } = res.data;
  const active = e.status === "active";
  return (
    <div className="flex max-w-5xl flex-col gap-4">
      <div>
        <Link href="/admin/webhooks" className="link text-sm">← Webhooks</Link>
        <h1 className="h1 mt-1 break-all">{e.url}</h1>
        <p className="text-sm text-muted">
          {e.status}{e.disabledReason && ` (${e.disabledReason.replaceAll("_", " ")})`} · {e.consecutiveFailures} failed attempt(s) in a row
        </p>
      </div>
      <section className="card">
        <ActionForm action={saveWebhookAction.bind(null, e.id)} submit="Save endpoint">
          <input type="hidden" name="version" value={e.version} />
          <EndpointFields url={e.url} description={e.description ?? ""} events={e.events} />
        </ActionForm>
      </section>
      <section className="card flex flex-col gap-3 sm:flex-row sm:gap-8">
        <ActionForm action={rotateWebhookAction.bind(null, e.id)} submit="Rotate secret">
          <input type="hidden" name="version" value={e.version} />
          <p className="text-sm text-muted">Issues a new signing secret; the old one stops working at once.</p>
        </ActionForm>
        <ActionForm action={toggleWebhookAction.bind(null, e.id)} submit={active ? "Disable" : "Enable"}>
          <input type="hidden" name="version" value={e.version} />
          <input type="hidden" name="active" value={String(!active)} />
          <p className="text-sm text-muted">{active ? "Pending deliveries are dropped." : "Re-enabling resets the failure count; failed deliveries are not resent."}</p>
        </ActionForm>
      </section>
      <section className="card overflow-x-auto p-0">
        <table className="table">
          <thead><tr><th>Event</th><th>Created</th><th>Status</th><th>Attempts</th><th>Last result</th><th>Next attempt</th></tr></thead>
          <tbody>
            {deliveries.map((d) => (
              <tr key={d.id}>
                <td><span className="font-mono text-xs">{d.event.type}</span><div className="font-mono text-xs text-muted">{d.eventId}</div></td>
                <td className="whitespace-nowrap">{d.event.createdAt.toISOString().slice(0, 19).replace("T", " ")}</td>
                <td>{d.status}</td>
                <td>{d.attempts}</td>
                <td className="text-xs">{d.lastStatusCode ? `HTTP ${d.lastStatusCode}` : ""} {d.lastError ?? ""}</td>
                <td className="whitespace-nowrap">{d.status === "pending" ? d.nextAttemptAt.toISOString().slice(0, 19).replace("T", " ") : ""}</td>
              </tr>
            ))}
            {!deliveries.length && <tr><td colSpan={6} className="text-muted">No deliveries yet.</td></tr>}
          </tbody>
        </table>
      </section>
    </div>
  );
}
