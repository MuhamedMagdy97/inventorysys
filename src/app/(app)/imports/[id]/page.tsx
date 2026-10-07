import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/app/ui/action-form";
import { Denied } from "@/app/ui/denied";
import { pageData } from "@/server/auth/page-ctx";
import { getImport } from "@/server/imports/imports";
import { cancelImportAction, confirmImportAction } from "../actions";

export const metadata: Metadata = { title: "Import" };

const PREVIEW_ROWS = 200;

export default async function ImportPage({ params }: PageProps<"/imports/[id]">) {
  const { id } = await params;
  const res = await pageData((ctx) => getImport(ctx, id));
  if ("denied" in res) return <Denied message={res.denied} />;
  const j = res.data;
  const errs = new Map<number, string[]>();
  for (const e of j.errors) errs.set(e.row, [...(errs.get(e.row) ?? []), e.message]);
  const cols = Object.keys(j.rows[0] ?? {}).filter((k) => k !== "row");
  const version = <input type="hidden" name="version" value={j.version} />;
  const result = j.result as Record<string, unknown> | null;

  return (
    <div className="flex max-w-6xl flex-col gap-6">
      <div>
        <Link href="/imports" className="link text-sm">← Import / export</Link>
        <h1 className="h1 mt-1">{j.fileName}</h1>
        <p className="text-sm text-muted">
          {j.type} · {j.status}{j.mode && ` (${j.mode})`} · {j.rowCount} row(s), {j.errorCount} with errors · uploaded by {j.creator.name} · sha256 {j.fileSha256.slice(0, 12)}…
        </p>
      </div>

      {j.status === "previewed" && (
        <section className="flex flex-wrap gap-3">
          <ActionForm action={confirmImportAction.bind(null, j.id)} submit="Confirm import" className="flex items-end gap-2">
            {version}
            <label className="label">
              Mode
              <select name="mode" className="input">
                <option value="all_or_nothing">All or nothing</option>
                <option value="valid_only">Valid rows only (skip {j.errorCount})</option>
              </select>
            </label>
          </ActionForm>
          <ActionForm action={cancelImportAction.bind(null, j.id)} submit="Discard" className="flex gap-2">{version}</ActionForm>
        </section>
      )}

      {result && (
        <section className="card text-sm">
          {"error" in result ? <p className="text-red-600">Failed, nothing was written: {String(result.error)}</p> : <p>Imported {String(result.imported)} row(s), skipped {String(result.skipped)}.</p>}
          {typeof result.adjustmentId === "string" && <p>Opening document <Link href={`/adjustments/${result.adjustmentId}`} className="link">{String(result.number)}</Link> is waiting for approval.</p>}
        </section>
      )}

      {errs.get(0) && <p role="alert" className="text-sm text-red-600">File: {errs.get(0)!.join("; ")}</p>}

      <section className="card overflow-x-auto p-0">
        <table className="table">
          <thead><tr><th>Row</th>{cols.map((c) => <th key={c}>{c}</th>)}<th>Problem</th></tr></thead>
          <tbody>
            {j.rows.slice(0, PREVIEW_ROWS).map((r) => (
              <tr key={r.row} className={errs.has(Number(r.row)) ? "bg-red-50 dark:bg-red-950" : undefined}>
                <td>{r.row}</td>
                {cols.map((c) => <td key={c}>{r[c]}</td>)}
                <td className="text-red-600">{errs.get(Number(r.row))?.join("; ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {j.rows.length > PREVIEW_ROWS && <p className="p-3 text-xs text-muted">Showing the first {PREVIEW_ROWS} of {j.rows.length} rows; every row was checked.</p>}
      </section>
    </div>
  );
}
