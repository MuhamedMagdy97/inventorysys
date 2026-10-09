import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/app/ui/action-form";
import { pageData } from "@/server/auth/page-ctx";
import { getPreferences, listNotifications } from "@/server/notifications/center";
import { CATEGORIES } from "@/server/notifications/notify";
import { markAllReadAction, markOneReadAction, preferencesAction } from "./actions";

export const metadata: Metadata = { title: "Notifications" };

// Doc 25 notification center + doc 17 N-02 preferences (in-app always; email opt-in).
export default async function NotificationsPage({ searchParams }: PageProps<"/notifications">) {
  const sp = await searchParams;
  const unreadOnly = sp.unread === "1";
  const res = await pageData(async (ctx) => ({
    list: await listNotifications(ctx, { page: 1, perPage: 100, unreadOnly }), // ponytail: newest 100
    prefs: await getPreferences(ctx),
  }));
  if ("denied" in res) return null;
  const { list, prefs } = res.data;
  return (
    <div className="flex max-w-4xl flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="h1">Notifications</h1>
        <div className="flex items-center gap-3 text-sm">
          <Link href={unreadOnly ? "/notifications" : "/notifications?unread=1"} className="link">{unreadOnly ? "Show all" : `Unread only (${list.unread})`}</Link>
          {list.unread > 0 && <ActionForm action={markAllReadAction} submit="Mark all read" className="flex" ><span /></ActionForm>}
        </div>
      </div>
      <div className="card overflow-x-auto p-0">
        <table className="table">
          <thead><tr><th>When</th><th>Message</th><th /></tr></thead>
          <tbody>
            {list.items.length === 0 && <tr><td colSpan={3} className="text-muted">Nothing here.</td></tr>}
            {list.items.map((n) => (
              <tr key={n.id} className={n.readAt ? "text-muted" : "font-medium"}>
                <td className="whitespace-nowrap">{n.createdAt.toISOString().slice(0, 16).replace("T", " ")}</td>
                <td>{n.link ? <Link href={n.link} className="link">{n.message}</Link> : n.message}<div className="text-xs text-muted">{n.type}</div></td>
                <td>{!n.readAt && <ActionForm action={markOneReadAction.bind(null, n.id)} submit="Read" className="flex"><span /></ActionForm>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <section className="card">
        <h2 className="mb-2 font-semibold">Email me about</h2>
        <ActionForm action={preferencesAction} submit="Save preferences">
          {Object.entries(CATEGORIES).map(([k, c]) => (
            <label key={k} className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="emailCategories" value={k} defaultChecked={prefs.emailCategories.includes(k as keyof typeof CATEGORIES)} />
              {c.label} <span className="text-muted">({c.mode === "digest" ? "daily digest" : "instant"})</span>
            </label>
          ))}
          <p className="text-xs text-muted">In-app notifications are always on. You only get what your warehouses and role allow.</p>
        </ActionForm>
      </section>
    </div>
  );
}
