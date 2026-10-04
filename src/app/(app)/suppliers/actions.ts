"use server";

import type { AddressType, MasterStatus, PaymentTerms } from "@/generated/prisma/client";
import { bool, clearable, int, str, version } from "@/app/ui/form";
import { runAction, type ActionState } from "@/server/auth/page-ctx";
import { lookupCodes } from "@/server/catalog/catalog";
import { AppError } from "@/server/core/errors";
import {
  addSupplierAddress, addSupplierContact, addSupplierDocument, archiveSupplierChild, createSupplier, setSupplierProduct, updateSupplier,
} from "@/server/suppliers/suppliers";

const profile = (f: FormData) => ({
  taxId: clearable(f, "taxId"), paymentTerms: str(f, "paymentTerms") as PaymentTerms | undefined, creditLimit: clearable(f, "creditLimit"),
  leadTimeDays: int(f, "leadTimeDays") ?? null, notes: clearable(f, "notes"), requiresInspection: bool(f, "requiresInspection"),
});

export async function createSupplierAction(_: ActionState, f: FormData): Promise<ActionState> {
  return runAction("suppliers.create", (tx, ctx) => createSupplier(tx, ctx, {
    name: str(f, "name") ?? "", currency: str(f, "currency")?.toUpperCase(), ...profile(f),
  }), "Created", (s) => `/suppliers/${s.id}`);
}

export async function updateSupplierAction(id: string, _: ActionState, f: FormData): Promise<ActionState> {
  return runAction("suppliers.update", (tx, ctx) => updateSupplier(tx, ctx, {
    id, version: version(f), name: str(f, "name"), currency: str(f, "currency")?.toUpperCase(), ...profile(f),
  }));
}

export async function supplierStatusAction(id: string, _: ActionState, f: FormData): Promise<ActionState> {
  return runAction("suppliers.status", (tx, ctx) => updateSupplier(tx, ctx, { id, version: version(f), status: f.get("status") as MasterStatus }));
}

export async function addContactAction(supplierId: string, _: ActionState, f: FormData): Promise<ActionState> {
  return runAction("suppliers.contact", (tx, ctx) => addSupplierContact(tx, ctx, {
    supplierId, name: str(f, "name") ?? "", role: str(f, "role"), email: str(f, "email"), phone: str(f, "phone"), isPrimary: bool(f, "isPrimary"),
  }), "Contact added");
}

export async function addAddressAction(supplierId: string, _: ActionState, f: FormData): Promise<ActionState> {
  return runAction("suppliers.address", (tx, ctx) => addSupplierAddress(tx, ctx, {
    supplierId, type: (str(f, "type") ?? "primary") as AddressType, line1: str(f, "line1") ?? "", line2: str(f, "line2"),
    city: str(f, "city") ?? "", postalCode: str(f, "postalCode"), country: str(f, "country") ?? "",
  }), "Address added");
}

export async function archiveChildAction(supplierId: string, kind: "contact" | "address", id: string): Promise<ActionState> {
  return runAction("suppliers.child_archive", (tx, ctx) => archiveSupplierChild(tx, ctx, { supplierId, kind, id }), "Removed");
}

// Linked by SKU as typed/scanned; must resolve to exactly one variant (never auto-pick).
export async function linkProductAction(supplierId: string, _: ActionState, f: FormData): Promise<ActionState> {
  return runAction("suppliers.product", async (tx, ctx) => {
    const [hit] = await lookupCodes(ctx, [str(f, "sku") ?? ""]);
    if (!hit || hit.result !== "found") {
      throw new AppError("validation_error", hit?.result === "ambiguous" ? `${hit.code} matches ${hit.matches.map((m) => m.sku).join(", ")}; enter the exact SKU` : "SKU not found");
    }
    return setSupplierProduct(tx, ctx, {
      supplierId, variantId: hit.matches[0].variantId, supplierSku: str(f, "supplierSku"), lastPrice: str(f, "lastPrice"),
      minOrderQty: str(f, "minOrderQty"), leadDays: int(f, "leadDays"), isPreferred: bool(f, "isPreferred"),
    });
  }, "Linked");
}

export async function addDocumentAction(supplierId: string, _: ActionState, f: FormData): Promise<ActionState> {
  return runAction("suppliers.document", (tx, ctx) => addSupplierDocument(tx, ctx, { supplierId, type: str(f, "type") ?? "other", fileUrl: str(f, "fileUrl") ?? "" }), "Added");
}
