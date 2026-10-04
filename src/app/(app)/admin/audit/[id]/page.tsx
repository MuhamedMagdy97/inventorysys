import type { Metadata } from "next";
import Link from "next/link";
import { diff, getAudit } from "@/server/audit/queries";
import { Denied } from "@/app/ui/denied";
import { pageData } from "@/server/auth/page-ctx";

export const metadata: Metadata = { title: "Audit entry" };

const show = (v: unknown) => (v === undefined ? "—" : JSON.stringify(v));

export default async function AuditEntryPage({ params }: PageProps<"/admin/audit/[id]">) {
  const { id } = await params;
  const res = await pageData((ctx) => getAudit(ctx, id));
  if ("denied" in res) return <Denied message={res.denied} />;
  const a = res.data;
  const changes = diff(a.before ?? {}, a.after ?? {});
  return (
    <div className="flex max-w-5xl flex-col gap-4">
      <div>
        <Link href="/admin/audit" className="link text-sm">← Audit log</Link>
        <h1 className="h1 mt-1 font-mono">{a.action}</h1>
        <p className="text-sm text-muted">
          {a.at.toISOString()} · {a.actor?.name ?? a.actorId} · {a.entityType} {a.entityId}
          {a.channel && ` · ${a.channel}`}{a.requestId && ` · request ${a.requestId}`}
        </p>
        {a.reason && <p className="mt-1 text-sm">Reason: {a.reason}</p>}
      </div>
      <div className="card overflow-x-auto p-0">
        <table className="table">
          <thead><tr><th>Field</th><th>Before</th><th>After</th></tr></thead>
          <tbody>
            {changes.map((c) => (
              <tr key={c.path}>
                <td className="font-mono text-xs">{c.path}</td>
                <td className="break-all font-mono text-xs text-red-700 dark:text-red-400">{show(c.before)}</td>
                <td className="break-all font-mono text-xs text-green-700 dark:text-green-400">{show(c.after)}</td>
              </tr>
            ))}
            {!changes.length && <tr><td colSpan={3} className="text-muted">No field changes recorded.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
