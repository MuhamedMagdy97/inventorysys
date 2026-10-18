import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/app/ui/action-form";
import { Denied } from "@/app/ui/denied";
import { pageData } from "@/server/auth/page-ctx";
import { listEndpoints } from "@/server/webhooks/webhooks";
import { createWebhookAction } from "./actions";
import { EndpointFields } from "./fields";

export const metadata: Metadata = { title: "Webhooks" };

// Doc 24 webhooks: company-wide endpoints; the signing secret is shown once.
export default async function WebhooksPage() {
  const res = await pageData(listEndpoints);
  if ("denied" in res) return <Denied message={res.denied} />;
  return (
    <div className="flex max-w-4xl flex-col gap-6">
      <div>
        <h1 className="h1">Webhooks</h1>
        <p className="text-sm text-muted">
          Each event is POSTed as JSON, signed with <span className="font-mono">Webhook-Signature: v1=HMAC-SHA256(secret, &quot;timestamp.body&quot;)</span>.
          Failed deliveries retry for about 9 hours; an endpoint failing 15 times in a row is disabled.
        </p>
      </div>
      <div className="card overflow-x-auto p-0">
        <table className="table">
          <thead><tr><th>URL</th><th>Events</th><th>Status</th></tr></thead>
          <tbody>
            {res.data.map((e) => (
              <tr key={e.id}>
                <td><Link href={`/admin/webhooks/${e.id}`} className="link break-all">{e.url}</Link>{e.description && <div className="text-xs text-muted">{e.description}</div>}</td>
                <td className="font-mono text-xs">{e.events.join(", ")}</td>
                <td>{e.status}{e.disabledReason && <span className="text-xs text-muted"> ({e.disabledReason.replaceAll("_", " ")})</span>}</td>
              </tr>
            ))}
            {!res.data.length && <tr><td colSpan={3} className="text-muted">No endpoints yet.</td></tr>}
          </tbody>
        </table>
      </div>
      <section className="card">
        <h2 className="mb-3 font-semibold">New endpoint</h2>
        <ActionForm action={createWebhookAction} submit="Create endpoint">
          <EndpointFields />
        </ActionForm>
      </section>
    </div>
  );
}
