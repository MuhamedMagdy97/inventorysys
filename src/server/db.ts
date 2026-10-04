import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "@/generated/prisma/client";

// One client per process (each client owns a pool). The global cache stops
// Next.js dev hot-reload from opening a new pool on every edit.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;

export type Tx = Prisma.TransactionClient;

// Interactive transaction with explicit limits: Prisma's 5 s default is too
// short under lock contention (tech-stack rule 1).
export function transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.$transaction(fn, { maxWait: 10_000, timeout: 30_000 });
}
