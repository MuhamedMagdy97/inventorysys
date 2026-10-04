import { auth } from "@/server/auth/auth";
import { transaction } from "@/server/db";
import { createLoginUser } from "@/server/seed";

type Company = { company: { id: string }; roles: { id: string; code: string }[] };
const roleId = (w: Company, code: string) => w.roles.find((r) => r.code === code)!.id;

// A sales-channel service user with an API key → headers for requests (real auth path).
export async function apiKeyHeaders(w: Company, roleCode: string, warehouseIds: string[] = []) {
  const user = await transaction(async (tx) => {
    const u = await tx.user.create({
      data: { companyId: w.company.id, name: `svc-${roleCode}`, email: `svc+${crypto.randomUUID()}@test.invalid`, isService: true },
    });
    await tx.userRole.create({ data: { companyId: w.company.id, userId: u.id, roleId: roleId(w, roleCode) } });
    for (const warehouseId of warehouseIds) await tx.userWarehouse.create({ data: { companyId: w.company.id, userId: u.id, warehouseId } });
    return u;
  });
  const key = await auth.api.createApiKey({ body: { userId: user.id, name: "test" } });
  return { user, headers: { "x-api-key": key.key } as Record<string, string> };
}

// A login user; `signIn()` goes through Better Auth's real email+password endpoint.
export async function loginUser(w: Company, roleCode: string, warehouseIds: string[] = []) {
  const email = `u+${crypto.randomUUID()}@test.invalid`;
  const password = `pw-${crypto.randomUUID()}`;
  const user = await transaction((tx) =>
    createLoginUser(tx, w.company.id, { name: roleCode, email, password, roleId: roleId(w, roleCode), warehouseIds }));
  return { user, email, password, signIn: (pw = password) => signIn(email, pw) };
}

export async function signIn(email: string, password: string) {
  const res = await auth.handler(new Request("http://localhost:3000/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:3000" },
    body: JSON.stringify({ email, password }),
  }));
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  return { status: res.status, body: await res.json().catch(() => null), headers: { cookie } as Record<string, string> };
}
