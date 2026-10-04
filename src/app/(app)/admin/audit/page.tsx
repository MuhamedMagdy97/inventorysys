import type { Metadata } from "next";
import Link from "next/link";
import { z } from "zod";
import { listAudit } from "@/server/audit/queries";
import { Denied } from "@/app/ui/denied";
import { pageData } from "@/server/auth/page-ctx";

export const metadata: Metadata = { title: "Audit log" };

const Query = z.object({
  page: z.coerce.number().int().min(1).catch(1),
  entityType: z.string().max(64).optional().catch(undefined),
  entityId: z.string().max(200).optional().catch(undefined),
  action: z.string().max(64).optional().catch(undefined),
});
const PER_PAGE = 50;

export default async function AuditPage({ searchParams }: PageProps<"/admin/audit">) {
  const raw = Object.fromEntries(Object.entries(await searchParams).filter(([, v]) => typeof v === "string" && v !== ""));
  const q = Query.parse(raw);
  const loaded = await pageData((ctx) => listAudit(ctx, { ...q, perPage: PER_PAGE }));
  if ("denied" in loaded) return <Denied message={loaded.denied} />;
  const res = loaded.data;
  const pages = Math.max(1, Math.ceil(res.total / PER_PAGE));
  const href = (page: number) => `?${new URLSearchParams({ ...raw, page: String(page) } as Record<string, string>)}`;

  return (
    <div className="flex max-w-6xl flex-col gap-4">
      <h1 className="h1">Audit log</h1>
      <form className="card flex flex-col gap-3 sm:flex-row sm:items-end">
        <label className="label">Entity type<input name="entityType" defaultValue={q.entityType} placeholder="user, role, reservation…" className="input" /></label>
        <label className="label">Entity id<input name="entityId" defaultValue={q.entityId} className="input" /></label>
        <label className="label">Action<input name="action" defaultValue={q.action} placeholder="update, access.denied…" className="input" /></label>
        <button className="btn">Filter</button>
      </form>
      <div className="card overflow-x-auto p-0">
        <table className="table">
          <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Entity</th><th>Reason</th></tr></thead>
          <tbody>
            {res.items.map((a) => (
              <tr key={a.id}>
                <td className="whitespace-nowrap"><Link href={`/admin/audit/${a.id}`} className="link">{a.at.toISOString().replace("T", " ").slice(0, 19)}</Link></td>
                <td>{a.actor?.name ?? a.actorId}</td>
                <td className="font-mono text-xs">{a.action}</td>
                <td><span className="text-muted">{a.entityType}</span> <span className="font-mono text-xs">{a.entityId}</span></td>
                <td className="text-muted">{a.reason}</td>
              </tr>
            ))}
            {!res.items.length && <tr><td colSpan={5} className="text-muted">No entries match.</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="flex items-center gap-3 text-sm">
        {q.page > 1 && <Link href={href(q.page - 1)} className="btn">Previous</Link>}
        <span className="text-muted">Page {q.page} of {pages} · {res.total} entries</span>
        {q.page < pages && <Link href={href(q.page + 1)} className="btn">Next</Link>}
      </div>
    </div>
  );
}
