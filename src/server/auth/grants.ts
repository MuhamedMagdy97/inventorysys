// Canonical grants (doc 02 §2) and the seed role matrix (doc 02 §5.1). Pure data.

const expand = (resource: string, actions: string) => actions.split("/").map((a) => `${resource}.${a}`);

export const PERMISSIONS = [
  ...expand("products", "view/create/update/archive"),
  "categories.manage", "brands.manage", "uom.manage",
  ...expand("suppliers", "view/create/update/archive"),
  ...expand("warehouses", "view/create/update/archive"), "locations.manage", "warehouses.assign_staff",
  ...expand("inventory", "view/receive/count_create/count_submit/count_approve/count_apply/adjust_create/adjust_submit/adjust_approve/adjust_apply/damage_mark/damage_approve/repair_approve/dispose_approve/transfer_create/transfer_submit/transfer_approve/transfer_ship/transfer_receive/inspect"),
  ...expand("purchases", "view/create/update/submit/approve/order/close/cancel/return_create/return_approve/return_ship"),
  ...expand("sales", "view/reserve/fulfil/cancel/return_create/return_approve/return_receive/return_inspect"),
  ...expand("reports", "view/export"),
  ...expand("users", "view/manage"), "roles.manage", "audit.view", "settings.manage", "imports.run", "sequences.view",
  "system.migration_run",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

// Doc 02 §3: these are checked against the user's warehouses.
export const WAREHOUSE_SCOPED = new Set<string>([
  ...PERMISSIONS.filter((p) => p.startsWith("inventory.")),
  "sales.reserve", "sales.fulfil", "sales.return_receive", "sales.return_inspect", "purchases.return_ship",
]);

const all = (resource: string) => PERMISSIONS.filter((p) => p.startsWith(`${resource}.`));
const views = PERMISSIONS.filter((p) => p.endsWith(".view"));

type RoleSeed = { name: string; grants: (string | [string, number])[]; allWarehouses?: boolean; requires2fa?: boolean };

export const ROLE_SEEDS: Record<string, RoleSeed> = {
  super_admin: {
    name: "Super Admin", allWarehouses: true, requires2fa: true,
    grants: PERMISSIONS.filter((p) => p !== "system.migration_run"),
  },
  owner: {
    name: "Business Owner", allWarehouses: true, requires2fa: true,
    grants: [
      ...views, ...all("reports"), "audit.view", "settings.manage", "purchases.approve", "purchases.return_approve",
      ...expand("inventory", "adjust_approve/transfer_approve/count_approve/damage_approve/repair_approve/dispose_approve"),
      "sales.return_approve",
    ],
  },
  admin: {
    name: "Administrator", requires2fa: true,
    grants: [
      ...all("users"), "roles.manage", "audit.view", "settings.manage", "imports.run", "sequences.view",
      ...all("products"), "categories.manage", "brands.manage", "uom.manage", ...all("suppliers"), ...all("warehouses"), "locations.manage",
    ],
  },
  inventory_manager: {
    name: "Inventory Manager", allWarehouses: true,
    grants: [
      ...expand("products", "view/create/update"), "suppliers.view", "warehouses.view", "locations.manage",
      ...all("inventory").filter((p) => !/(adjust|damage|repair|dispose)_approve$/.test(p)),
      ["inventory.adjust_approve", 1000], ["inventory.damage_approve", 1000], ["inventory.repair_approve", 1000], ["inventory.dispose_approve", 1000],
      "sales.view", "sales.return_approve", "purchases.view", ["purchases.return_approve", 1000], ...all("reports"), "audit.view",
    ],
  },
  warehouse_manager: {
    name: "Warehouse Manager",
    grants: [
      "products.view", "suppliers.view", "warehouses.view", "locations.manage",
      ...expand("inventory", "view/receive/count_create/count_submit/adjust_create/adjust_submit/damage_mark/transfer_create/transfer_submit/transfer_approve/transfer_ship/transfer_receive/inspect"),
      "purchases.view", "purchases.return_ship", ...expand("sales", "view/fulfil/return_receive/return_inspect"), "reports.view", "audit.view",
    ],
  },
  warehouse_staff: {
    name: "Warehouse Staff",
    grants: [
      "products.view", "warehouses.view", ...expand("inventory", "view/receive/count_submit/transfer_ship/transfer_receive/damage_mark"),
      ...expand("sales", "view/fulfil/return_receive"),
    ],
  },
  purchasing_manager: {
    name: "Purchasing Manager",
    grants: [
      "products.view", ...all("suppliers"),
      ...all("purchases").filter((p) => p !== "purchases.approve" && p !== "purchases.return_approve"),
      ["purchases.approve", 5000], ["purchases.return_approve", 5000], "reports.view",
    ],
  },
  purchasing_staff: {
    name: "Purchasing Staff",
    grants: ["products.view", ...expand("suppliers", "view/create/update"), ...expand("purchases", "view/create/update/submit/return_create")],
  },
  sales_staff: {
    name: "Sales Staff",
    grants: ["products.view", "inventory.view", ...expand("sales", "view/reserve/fulfil/cancel/return_create")],
  },
  accountant: {
    name: "Accountant",
    grants: ["products.view", "suppliers.view", "warehouses.view", "inventory.view", "purchases.view", "sales.view", ...all("reports"), "audit.view"],
  },
  auditor: {
    name: "Auditor", allWarehouses: true,
    grants: [...views, ...all("reports"), "audit.view", "sequences.view"],
  },
  viewer: {
    name: "Viewer",
    grants: ["products.view", "warehouses.view", "inventory.view", "reports.view"],
  },
};
