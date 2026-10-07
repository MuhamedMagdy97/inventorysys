import Link from "next/link";
import { pageCtx } from "@/server/auth/page-ctx";
import { db } from "@/server/db";
import { signOutAction } from "../login/actions";

// Doc 25 shell. Nav entries are hidden without their grant (cosmetic only — every
// page and action re-checks through its domain function).
const NAV = [
  { href: "/", label: "Home", grant: null },
  { href: "/products", label: "Products", grant: "products.view" },
  { href: "/suppliers", label: "Suppliers", grant: "suppliers.view" },
  { href: "/purchase-orders", label: "Purchasing", grant: ["purchases.view", "inventory.receive"] },
  { href: "/sales-orders", label: "Sales", grant: "sales.view" },
  { href: "/transfers", label: "Transfers", grant: "inventory.view" },
  { href: "/adjustments", label: "Adjustments", grant: "inventory.view" },
  { href: "/counts", label: "Counts", grant: "inventory.view" },
  { href: "/approvals", label: "Approvals", grant: ["purchases.approve", "inventory.transfer_approve", "inventory.adjust_approve", "inventory.adjust_apply", "inventory.damage_approve", "inventory.repair_approve", "inventory.dispose_approve", "inventory.count_approve", "inventory.count_apply"] },
  { href: "/warehouses", label: "Warehouses", grant: "warehouses.view" },
  { href: "/admin/users", label: "Users", grant: "users.view" },
  { href: "/admin/roles", label: "Roles", grant: "roles.manage" },
  { href: "/imports", label: "Import / export", grant: ["imports.run", "reports.export"] },
  { href: "/admin/audit", label: "Audit log", grant: "audit.view" },
  { href: "/admin/settings", label: "Settings", grant: "settings.manage" },
] as const;

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const ctx = await pageCtx();
  const [user, company] = await Promise.all([
    db.user.findUniqueOrThrow({ where: { id: ctx.userId }, select: { name: true, email: true } }),
    db.company.findUniqueOrThrow({ where: { id: ctx.companyId }, select: { name: true } }),
  ]);
  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="flex items-center justify-between gap-4 border-b border-border bg-surface px-4 py-3">
        <span className="font-semibold">{company.name}</span>
        <div className="flex items-center gap-3 text-sm">
          <span className="hidden text-muted sm:inline">{user.name} · {user.email}</span>
          <form action={signOutAction}><button className="btn">Sign out</button></form>
        </div>
      </header>
      <div className="flex flex-1 flex-col md:flex-row">
        <nav aria-label="Main" className="flex gap-1 overflow-x-auto border-b border-border bg-surface p-2 md:w-48 md:flex-col md:border-b-0 md:border-r">
          {NAV.filter((n) => !n.grant || [n.grant].flat().some((g) => ctx.permissions.has(g))).map((n) => (
            <Link key={n.href} href={n.href} className="whitespace-nowrap rounded-md px-3 py-2 text-sm hover:bg-background">{n.label}</Link>
          ))}
        </nav>
        <main className="flex-1 p-4 md:p-6">{children}</main>
      </div>
    </div>
  );
}
