"use server";

import type { BinType, MasterStatus } from "@/generated/prisma/client";
import { clearable, str, version } from "@/app/ui/form";
import { runAction, type ActionState } from "@/server/auth/page-ctx";
import { createBin, createWarehouse, setWarehouseStaff, updateBin, updateWarehouse } from "@/server/warehouses/warehouses";

export async function createWarehouseAction(_: ActionState, f: FormData): Promise<ActionState> {
  return runAction("warehouses.create", (tx, ctx) => createWarehouse(tx, ctx, {
    code: str(f, "code") ?? "", name: str(f, "name") ?? "", address: str(f, "address"),
  }), "Created", (w) => `/warehouses/${w.id}`);
}

export async function updateWarehouseAction(id: string, _: ActionState, f: FormData): Promise<ActionState> {
  return runAction("warehouses.update", (tx, ctx) => updateWarehouse(tx, ctx, {
    id, version: version(f), name: str(f, "name"), address: clearable(f, "address"), managerUserId: clearable(f, "managerUserId"),
  }));
}

export async function warehouseStatusAction(id: string, _: ActionState, f: FormData): Promise<ActionState> {
  return runAction("warehouses.status", (tx, ctx) => updateWarehouse(tx, ctx, { id, version: version(f), status: f.get("status") as MasterStatus }));
}

export async function createBinAction(warehouseId: string, _: ActionState, f: FormData): Promise<ActionState> {
  return runAction("bins.create", (tx, ctx) => createBin(tx, ctx, {
    warehouseId, code: str(f, "code") ?? "", type: (str(f, "type") ?? "sellable") as BinType,
    zone: str(f, "zone"), rack: str(f, "rack"), shelf: str(f, "shelf"),
  }), "Bin added");
}

export async function binAction(id: string, op: "archive" | "unarchive" | "sellable" | "receiving", _: ActionState, f: FormData): Promise<ActionState> {
  return runAction("bins.update", (tx, ctx) => updateBin(tx, ctx, {
    id, version: version(f),
    ...(op === "archive" ? { archived: true } : op === "unarchive" ? { archived: false } : { makeDefault: op }),
  }));
}

export async function staffAction(warehouseId: string, assigned: boolean, _: ActionState, f: FormData): Promise<ActionState> {
  return runAction("warehouses.staff", (tx, ctx) => setWarehouseStaff(tx, ctx, { warehouseId, userId: str(f, "userId") ?? "", assigned }),
    assigned ? "Assigned" : "Removed");
}
