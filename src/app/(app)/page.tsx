import Link from "next/link";
import { pageCtx } from "@/server/auth/page-ctx";
import { db } from "@/server/db";
import { getDashboard } from "@/server/reports/dashboard";

// Doc 16 §1 dashboard (scope-aware). Users without inventory/report access get the
// account summary instead.
const QUICK = [
  { href: "/purchase-orders/new", label: "New PO", grant: "purchases.create" },
  { href: "/purchase-orders", label: "Receive", grant: "inventory.receive" },
  { href: "/transfers/new", label: "New transfer", grant: "inventory.transfer_create" },
  { href: "/adjustments/new", label: "New adjustment", grant: "inventory.adjust_create" },
  { href: "/products", label: "New product", grant: "products.create" },
];

export default async function HomePage() {
  const ctx = await pageCtx();
  if (!ctx.permissions.has("inventory.view") && !ctx.permissions.has("reports.view")) return <Welcome />;
  const d = await getDashboard(ctx);
  const k = d.kpis;
  const tiles: [string, string | number, string?][] = [
    ["Inventory value", k.inventoryValue, `incl. ${k.inTransitValue} in transit`], ["Active SKUs", k.skusActive], ["Units on hand", k.totalUnits],
    ["Low stock", k.lowStock], ["Out of stock", k.outOfStock], ["Expiring ≤ 30 d", k.expiring30.positions, `${k.expiring30.units} units`],
    ["Damaged value", k.damagedValue], ["Pending POs", k.pendingPos], ["Pending transfers", k.pendingTransfers], ["Open adjustments", k.openAdjustments],
  ];
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="h1">Dashboard</h1>
        <div className="flex flex-wrap gap-2">
          {QUICK.filter((q) => ctx.permissions.has(q.grant)).map((q) => <Link key={q.label} href={q.href} className="btn">{q.label}</Link>)}
        </div>
      </div>

      {d.alerts.length > 0 && (
        <div className="flex flex-col gap-1">
          {d.alerts.map((a) => (
            <Link key={a.text} href={a.link} role="alert" className="rounded-md border border-amber-400 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100">{a.text}</Link>
          ))}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {tiles.map(([label, value, sub]) => (
          <div key={label} className="card">
            <div className="text-xs text-muted">{label}</div>
            <div className="text-xl font-semibold tabular-nums">{value}</div>
            {sub && <div className="text-xs text-muted">{sub}</div>}
          </div>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Bars title="Value by warehouse" data={d.charts.valueByWarehouse} />
        <Bars title="Value by category" data={d.charts.valueByCategory} />
        <Volume data={d.charts.movements30d} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <section className="card overflow-x-auto p-0">
          <h2 className="px-3 pt-3 font-semibold"><Link href="/reports/low-stock" className="link">Low / out of stock</Link></h2>
          <table className="table">
            <tbody>
              {d.lowStock.length === 0 && <tr><td className="text-muted">All stocked.</td></tr>}
              {d.lowStock.map((r) => <tr key={r.sku + r.warehouse}><td>{r.sku}</td><td>{r.warehouse}</td><td className="text-right tabular-nums">{r.available}</td><td className={r.status === "out" ? "text-red-600" : "text-amber-700"}>{r.status}</td></tr>)}
            </tbody>
          </table>
        </section>
        <section className="card overflow-x-auto p-0">
          <h2 className="px-3 pt-3 font-semibold"><Link href="/approvals" className="link">Pending approvals</Link></h2>
          <table className="table">
            <tbody>
              {d.approvals.length === 0 && <tr><td className="text-muted">Nothing waiting on you.</td></tr>}
              {d.approvals.map((a) => <tr key={a.type + a.id}><td><Link href={a.link} className="link">{a.number}</Link></td><td>{a.summary}</td><td className={a.overdue ? "text-red-600" : "text-muted"}>{a.ageHours} h</td></tr>)}
            </tbody>
          </table>
        </section>
        <section className="card overflow-x-auto p-0">
          <h2 className="px-3 pt-3 font-semibold">Recent activity</h2>
          <table className="table">
            <tbody>
              {d.recent.length === 0 && <tr><td className="text-muted">No activity yet.</td></tr>}
              {d.recent.map((r, i) => <tr key={i}><td className="whitespace-nowrap text-muted">{r.at.toISOString().slice(5, 16).replace("T", " ")}</td><td><Link href={r.link} className="link">{r.text}</Link></td></tr>)}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}

function Bars({ title, data }: { title: string; data: { label: string; value: string }[] }) {
  const max = Math.max(...data.map((x) => Number(x.value)), 1); // display scale only
  return (
    <section className="card">
      <h2 className="mb-2 font-semibold">{title}</h2>
      {data.length === 0 && <p className="text-sm text-muted">No stock value yet.</p>}
      <ul className="flex flex-col gap-2 text-sm">
        {data.slice(0, 8).map((x) => (
          <li key={x.label}>
            <div className="flex justify-between gap-2"><span className="truncate">{x.label}</span><span className="tabular-nums">{x.value}</span></div>
            <div className="h-2 rounded bg-background"><div className="h-2 rounded bg-accent" style={{ width: `${(Number(x.value) / max) * 100}%` }} /></div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Volume({ data }: { data: { day: string; count: number }[] }) {
  const max = Math.max(...data.map((x) => x.count), 1);
  return (
    <section className="card">
      <h2 className="mb-2 font-semibold">Movements, last 30 days</h2>
      <svg viewBox="0 0 300 100" className="h-32 w-full" role="img" aria-label="Movement count per day, last 30 days">
        {data.map((x, i) => {
          const h = (x.count / max) * 90;
          return <rect key={x.day} x={i * 10 + 1} y={100 - h} width={8} height={h} className="fill-accent"><title>{`${x.day}: ${x.count}`}</title></rect>;
        })}
      </svg>
      <div className="flex justify-between text-xs text-muted"><span>{data[0]?.day}</span><span>{data.at(-1)?.day}</span></div>
    </section>
  );
}

async function Welcome() {
  const ctx = await pageCtx();
  const roles = await db.userRole.findMany({ where: { userId: ctx.userId }, select: { role: { select: { name: true } } } });
  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <h1 className="h1">Welcome</h1>
      <div className="card text-sm">
        <p><span className="text-muted">Roles:</span> {roles.map((r) => r.role.name).join(", ") || "none"}</p>
        <p className="mt-1"><span className="text-muted">Permissions:</span> {ctx.permissions.size}</p>
      </div>
    </div>
  );
}
