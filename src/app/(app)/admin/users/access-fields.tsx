// Role + warehouse checkboxes shared by the create and edit forms.
export function AccessFields({
  roles, warehouses, roleIds = [], warehouseIds = [],
}: {
  roles: { id: string; name: string; allWarehouses: boolean }[];
  warehouses: { id: string; code: string; name: string }[];
  roleIds?: string[];
  warehouseIds?: string[];
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <fieldset className="flex flex-col gap-1 text-sm">
        <legend className="mb-1 font-medium">Roles</legend>
        {roles.map((r) => (
          <label key={r.id} className="flex items-center gap-2">
            <input type="checkbox" name="roleIds" value={r.id} defaultChecked={roleIds.includes(r.id)} />
            {r.name}
            {r.allWarehouses && <span className="text-xs text-muted">all warehouses</span>}
          </label>
        ))}
      </fieldset>
      <fieldset className="flex flex-col gap-1 text-sm">
        <legend className="mb-1 font-medium">Warehouses</legend>
        {warehouses.map((w) => (
          <label key={w.id} className="flex items-center gap-2">
            <input type="checkbox" name="warehouseIds" value={w.id} defaultChecked={warehouseIds.includes(w.id)} />
            {w.code} — {w.name}
          </label>
        ))}
        {!warehouses.length && <p className="text-muted">No warehouses yet.</p>}
      </fieldset>
    </div>
  );
}
