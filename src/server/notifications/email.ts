import { db } from "@/server/db";

// Doc 17 §3: every email lands in email_outbox first. A transport, when one is set
// (production wiring), sends `stored` rows; without one they stay `stored`, which is
// the dev/test behaviour (inspect the table). No SMTP dependency until a provider is chosen.
export type EmailTransport = (m: { to: string; subject: string; body: string }) => Promise<void>;

let transport: EmailTransport | null = null;
export const setEmailTransport = (t: EmailTransport | null) => {
  transport = t;
};

export async function flushOutbox(limit = 200) {
  if (!transport) return { sent: 0, failed: 0 };
  const rows = await db.emailOutbox.findMany({ where: { status: "stored" }, orderBy: { id: "asc" }, take: limit });
  let sent = 0, failed = 0;
  for (const r of rows) {
    try {
      await transport({ to: r.toEmail, subject: r.subject, body: r.body });
      await db.emailOutbox.update({ where: { id: r.id }, data: { status: "sent", sentAt: new Date() } });
      sent++;
    } catch (e) {
      await db.emailOutbox.update({ where: { id: r.id }, data: { status: "failed", error: String(e).slice(0, 500) } });
      failed++;
    }
  }
  return { sent, failed };
}
