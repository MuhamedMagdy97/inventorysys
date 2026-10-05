import { PgBoss } from "pg-boss";
import { expireDueReservations, runReconciler, sweepExpiredBatches } from "@/server/inventory/jobs";

// Background worker (tech stack: pg-boss, no Redis). `npm run worker`. Jobs are re-runnable
// (src/server/inventory/jobs.ts), so a crash or a redeploy mid-job only delays work.
const JOBS = [
  { name: "reservation-expiry", cron: "* * * * *", run: () => expireDueReservations() },
  { name: "batch-expiry-sweep", cron: "15 0 * * *", run: () => sweepExpiredBatches() }, // 00:15 UTC (edge #29)
  { name: "ledger-reconcile", cron: "45 1 * * *", run: () => runReconciler() },
];

async function main() {
  const boss = new PgBoss(process.env.DATABASE_URL!);
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
