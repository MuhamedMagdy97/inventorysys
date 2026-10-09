import { PgBoss } from "pg-boss";
import { validateEnv } from "@/server/env";
import { expireDueReservations, runReconciler, sweepExpiredBatches } from "@/server/inventory/jobs";
import { escalateApprovals, sendDigests, sendInstantEmails, stockAlerts } from "@/server/notifications/jobs";

// Background worker (tech stack: pg-boss, no Redis). `npm run worker`. Jobs are re-runnable
// (src/server/inventory/jobs.ts), so a crash or a redeploy mid-job only delays work.
const JOBS = [
  { name: "reservation-expiry", cron: "* * * * *", run: () => expireDueReservations() },
  { name: "batch-expiry-sweep", cron: "15 0 * * *", run: () => sweepExpiredBatches() }, // 00:15 UTC (edge #29)
  { name: "ledger-reconcile", cron: "45 1 * * *", run: () => runReconciler() },
  // Doc 17 (Part 9): stock alerts feed the 06:00 digest; instant mail + SLA run all day.
  { name: "stock-alerts", cron: "30 5 * * *", run: () => stockAlerts() },
  { name: "email-digest", cron: "0 6 * * *", run: () => sendDigests() },
  { name: "email-instant", cron: "* * * * *", run: () => sendInstantEmails() },
  { name: "approval-sla", cron: "5 * * * *", run: () => escalateApprovals() },
];

async function main() {
  const env = validateEnv(); // doc 26: fail fast on a bad environment
  const boss = new PgBoss(env.DATABASE_URL);
  boss.on("error", (e) => console.error("pg-boss", e));
  await boss.start();
  for (const job of JOBS) {
    // stately: at most one run active + one queued, even with several workers (no pile-up).
    await boss.createQueue(job.name, { policy: "stately" });
    await boss.schedule(job.name, job.cron, null, { tz: "UTC", missed: "once" }); // a worker down at 00:15 still sweeps
    await boss.work(job.name, async () => {
      const result = await job.run();
      console.log(new Date().toISOString(), job.name, JSON.stringify(result));
    });
  }
  console.log("worker started:", JOBS.map((j) => j.name).join(", "));

  const stop = async () => {
    await boss.stop({ graceful: true, timeout: 30_000 });
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
