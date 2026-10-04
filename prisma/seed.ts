import { db, transaction } from "@/server/db";
import { createLoginUser, seedCompany } from "@/server/seed";
import { seedRoles } from "@/server/users/roles";

// Idempotent dev seed: Demo Company + roles + login users.
//   admin@demo.local       super_admin (2FA required — the app walks you through TOTP setup)
//   manager@demo.local     inventory_manager, main warehouse (no 2FA; quickest way in)
//   buyer@demo.local       purchasing_staff — drafts and submits POs
//   purchasing@demo.local  purchasing_manager — approves (≤ 5000) and orders POs
//   receiver@demo.local    warehouse_staff, main warehouse — posts receipts
// Password for all: SEED_PASSWORD (see .env.example).
const NAME = "Demo Company";

async function main() {
  const password = process.env.SEED_PASSWORD;
  if (!password || password.length < 10) throw new Error("Set SEED_PASSWORD (≥ 10 chars) in .env");

  let company = await db.company.findFirst({ where: { name: NAME } });
  if (!company) company = (await seedCompany(NAME, { adminEmail: "admin@demo.local", adminPassword: password })).company;
  const main = await db.warehouse.findFirstOrThrow({ where: { companyId: company.id }, orderBy: { createdAt: "asc" } });

  await transaction(async (tx) => {
    const roles = await seedRoles(tx, company.id);
    const role = (code: string) => roles.find((r) => r.code === code)!.id;
    for (const [email, name, code, warehouseIds] of [
      ["admin@demo.local", "Admin", "super_admin", []],
      ["manager@demo.local", "Inventory Manager", "inventory_manager", [main.id]],
      ["buyer@demo.local", "Buyer", "purchasing_staff", []],
      ["purchasing@demo.local", "Purchasing Manager", "purchasing_manager", []],
      ["receiver@demo.local", "Receiver", "warehouse_staff", [main.id]],
    ] as const) {
      const existing = await tx.user.findUnique({ where: { email } });
      if (!existing) await createLoginUser(tx, company.id, { name, email, password, roleId: role(code), warehouseIds: [...warehouseIds] });
      else for (const warehouseId of warehouseIds) {
        await tx.userWarehouse.createMany({ data: [{ companyId: company.id, userId: existing.id, warehouseId }], skipDuplicates: true });
      }
    }
  });
  console.log(`Seeded ${NAME} (${company.id}) — log in as manager@, buyer@, purchasing@, receiver@ or admin@demo.local`);
}

main().finally(() => db.$disconnect());
