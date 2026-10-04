import { db } from "@/server/db";
import { seedCompany } from "@/server/seed";

// Idempotent: only seeds when the demo company is missing.
const NAME = "Demo Company";

async function main() {
  if (await db.company.findFirst({ where: { name: NAME } })) return console.log(`${NAME} already seeded`);
  const { company } = await seedCompany(NAME);
  console.log(`Seeded ${NAME} (${company.id})`);
}

main().finally(() => db.$disconnect());
