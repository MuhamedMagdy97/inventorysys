import { db, transaction } from "@/server/db";
import { createLoginUser, seedCompany } from "@/server/seed";
import { seedRoles } from "@/server/users/roles";

// Idempotent dev seed: Demo Company + roles + two login users.
//   admin@demo.local    super_admin (2FA required — the app walks you through TOTP setup)
//   manager@demo.local  inventory_manager (no 2FA needed; quickest way into the app)
// Password for both: SEED_PASSWORD (see .env.example).
const NAME = "Demo Company";

async function main() {
  const password = process.env.SEED_PASSWORD;
  if (!password || password.length < 10) throw new Error("Set SEED_PASSWORD (≥ 10 chars) in .env");

  let company = await db.company.findFirst({ where: { name: NAME } });
  if (!company) company = (await seedCompany(NAME, { adminEmail: "admin@demo.local", adminPassword: password })).company;

  await transaction(async (tx) => {
    const roles = await seedRoles(tx, company.id);
    const role = (code: string) => roles.find((r) => r.code === code)!.id;
    for (const [email, name, code] of [
      ["admin@demo.local", "Admin", "super_admin"],
      ["manager@demo.local", "Inventory Manager", "inventory_manager"],
    ] as const) {
      if (await tx.user.findUnique({ where: { email } })) continue;
      await createLoginUser(tx, company.id, { name, email, password, roleId: role(code) });
    }
  });
  console.log(`Seeded ${NAME} (${company.id}) — log in as manager@demo.local or admin@demo.local`);
}

main().finally(() => db.$disconnect());
