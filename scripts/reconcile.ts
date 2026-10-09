// Read-only ledger replay for every company in DATABASE_URL (restore drill, ad-hoc checks).
// Exit 1 on drift. Unlike the nightly job it writes nothing.
//   DATABASE_URL=... npx tsx scripts/reconcile.ts
import { db } from "@/server/db";
import { systemCtx } from "@/server/inventory/jobs";
import { reconcile } from "@/server/inventory/reconcile";

async function main() {
  let drift = 0;
  const companies = await db.company.findMany({ select: { id: true } });
  for (const { id } of companies) drift += (await reconcile(await systemCtx(id))).length;
  console.log(`reconciler: ${companies.length} companies, ${drift} drift rows`);
  await db.$disconnect();
  process.exit(drift ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await db.$disconnect();
  process.exit(1);
});
