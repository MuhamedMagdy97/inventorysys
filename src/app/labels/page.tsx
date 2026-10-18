import type { Metadata } from "next";
import { Denied } from "@/app/ui/denied";
import { pageData } from "@/server/auth/page-ctx";
import { AppError } from "@/server/core/errors";
import { getLabels, LabelQuery, type Label } from "@/server/labels/labels";
import { PrintButton } from "./print-button";

// Doc 25 "Barcode labels": outside the (app) shell so only labels reach the printer.
export const metadata: Metadata = { title: "Labels" };

const LAYOUTS = {
  a4: { page: "A4", w: 70, h: 37, cols: 3, perSheet: 24, sheet: { width: "210mm", height: "296mm", paddingTop: "4.5mm" } },
  thermal: { page: "50mm 30mm", w: 50, h: 30, cols: 1, perSheet: 1, sheet: { width: "50mm", height: "30mm" } },
} as const;

const QUIET = 10; // quiet-zone modules each side

function Barcode({ modules, value }: { modules: string; value: string }) {
  const bars: { x: number; w: number }[] = [];
  for (let i = 0; i < modules.length; i++) {
    if (modules[i] !== "1") continue;
    const start = i;
    while (modules[i + 1] === "1") i++;
    bars.push({ x: start + QUIET, w: i - start + 1 });
  }
  return (
    <svg viewBox={`0 0 ${modules.length + QUIET * 2} 1`} preserveAspectRatio="none" shapeRendering="crispEdges"
      role="img" aria-label={`Barcode ${value}`} className="block min-h-0 w-full flex-1">
      {bars.map((b) => <rect key={b.x} x={b.x} width={b.w} height={1} fill="#000" />)}
    </svg>
  );
}

function LabelBox({ l, w, h }: { l: Label; w: number; h: number }) {
  return (
    <div style={{ width: `${w}mm`, height: `${h}mm`, padding: "2mm 3mm" }} className="flex flex-col overflow-hidden bg-white text-black">
      <div className="truncate text-[8pt] font-semibold leading-tight">{l.title}</div>
      <Barcode modules={l.modules} value={l.value} />
      <div className="truncate text-center font-mono text-[7pt] leading-tight">{l.value}</div>
      {l.lines.length > 0 && <div className="truncate text-[7pt] leading-tight">{l.lines.join(" · ")}</div>}
    </div>
  );
}

const Message = ({ text }: { text: string }) => (
  <main className="p-6"><div className="card max-w-lg"><h1 className="h1">Can’t print labels</h1><p className="mt-2 text-sm text-muted">{text}</p></div></main>
);

export default async function LabelsPage({ searchParams }: PageProps<"/labels">) {
  const raw = Object.fromEntries(Object.entries(await searchParams).filter(([, v]) => typeof v === "string" && v !== "")) as Record<string, string>;
  const q = LabelQuery.safeParse(raw);
  if (!q.success) return <Message text="Check the link: kind (variant, bin, batch, receipt), up to 200 ids, copies 1–100, layout a4 or thermal." />;

  const res = await pageData(async (ctx) => {
    try {
      return { labels: await getLabels(ctx, q.data) };
    } catch (e) {
      if (e instanceof AppError && e.code === "validation_error") return { error: e.message };
      throw e;
    }
  });
  if ("denied" in res) return <main className="p-6"><Denied message={res.denied} /></main>;
  const { labels, error } = res.data;
  if (!labels) return <Message text={error ?? ""} />;

  const L = LAYOUTS[q.data.layout];
  const sheets: Label[][] = [];
  for (let i = 0; i < labels.length; i += L.perSheet) sheets.push(labels.slice(i, i + L.perSheet));
  const hidden = { ...raw, layout: undefined, copies: undefined, price: undefined };

  return (
    <main className="flex flex-col items-center gap-4 p-4 print:block print:p-0">
      <style>{`@page { size: ${L.page}; margin: 0 } @media print { body { background: #fff } .sheet { break-after: page } .sheet:last-child { break-after: auto } }`}</style>

      <form className="card flex flex-wrap items-end gap-3 print:hidden">
        {Object.entries(hidden).map(([k, v]) => v && <input key={k} type="hidden" name={k} value={v} />)}
        <label className="label">Layout
          <select name="layout" defaultValue={q.data.layout} className="input">
            <option value="a4">A4 sheet (3 × 8, 70 × 37 mm)</option>
            <option value="thermal">Thermal (50 × 30 mm)</option>
          </select>
        </label>
        <label className="label">Copies<input name="copies" type="number" min={1} max={100} defaultValue={q.data.copies} className="input w-24" /></label>
        {(q.data.kind === "variant" || q.data.kind === "receipt") && (
          <label className="flex items-center gap-2 pb-2 text-sm"><input type="checkbox" name="price" value="1" defaultChecked={!!q.data.price} /> Show price</label>
        )}
        <button className="btn">Update</button>
        <PrintButton />
        <span className="pb-2 text-sm text-muted">{labels.length} label{labels.length === 1 ? "" : "s"} · {sheets.length} page{sheets.length === 1 ? "" : "s"}</span>
      </form>

      {sheets.map((sheet, i) => (
        <div key={i} style={L.sheet} className="sheet overflow-hidden bg-white shadow print:shadow-none">
          <div className="grid" style={{ gridTemplateColumns: `repeat(${L.cols}, ${L.w}mm)` }}>
            {sheet.map((l, j) => <LabelBox key={j} l={l} w={L.w} h={L.h} />)}
          </div>
        </div>
      ))}
    </main>
  );
}
