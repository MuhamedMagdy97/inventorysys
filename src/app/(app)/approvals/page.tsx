import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/app/ui/action-form";
import { listInbox } from "@/server/approvals/inbox";
import { pageData } from "@/server/auth/page-ctx";
import { decideAction } from "./actions";

export const metadata: Metadata = { title: "Approvals" };

const TYPE: Record<string, string> = {
  purchase_order: "Purchase order", receipt_excess: "Over-delivery", transfer: "Transfer",
  transfer_variance: "Transfer loss", stock_adjustment: "Adjustment", adjustment_apply: "Ready to apply",
  purchase_return: "Return to supplier", sales_return: "Customer return",
};

// Doc 25 Approvals Inbox: oldest first, SLA age, approve / reject with comment.
export default async function ApprovalsPage() {
  const res = await pageData(listInbox);
  if ("denied" in res) return null; // listInbox never denies; it is empty without grants
  const { items, slaHours } = res.data;
  return (
    <div className="flex max-w-6xl flex-col gap-6">
      <div>
        <h1 className="h1">Approvals</h1>
        <p className="text-sm text-muted">Waiting on you, oldest first. Overdue after {slaHours} h.</p>
      </div>
      <div className="card overflow-x-auto p-0">
        <table className="table">
          <thead><tr><th>Waiting</th><th>Type</th><th>Document</th><th>What</th><th className="text-right">Amount</th><th>Decision</th></tr></thead>
          <tbody>
            {items.length === 0 && <tr><td colSpan={6} className="text-muted">Nothing is waiting on you.</td></tr>}
            {items.map((i) => (
              <tr key={`${i.type}-${i.id}`}>
                <td className={i.overdue ? "font-semibold text-red-600" : ""}>{i.ageHours} h{i.overdue && " · overdue"}</td>
                <td>{TYPE[i.type]}</td>
                <td><Link href={i.link} className="link font-mono text-xs">{i.number}</Link></td>
                <td>{i.summary}</td>
                <td className="text-right tabular-nums">{i.amount ?? "—"}{i.overLimit && <span className="block text-xs text-amber-600">above your limit</span>}</td>
                <td>
                  {i.overLimit ? <span className="text-xs text-muted">needs a higher limit</span> : (
                    <ActionForm action={decideAction.bind(null, { type: i.type, id: i.id, version: i.version }, crypto.randomUUID())} submit="Send" className="flex items-center gap-1">
                      <select name="decision" aria-label={`Decision on ${i.number}`} className="input">
                        <option value="approve">{i.type === "adjustment_apply" ? "Apply" : "Approve"}</option>
                        {i.type !== "adjustment_apply" && <option value="reject">Reject</option>}
                      </select>
                      <input name="comment" placeholder="Comment" aria-label={`Comment on ${i.number}`} className="input w-36" />
                    </ActionForm>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
