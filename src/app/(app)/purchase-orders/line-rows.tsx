// PO line editor rows (new PO + draft edit). Server-rendered, no client JS: blank rows
// are skipped on submit; a removed draft line is one whose SKU is cleared (PO-09).
type Line = { id: string; sku: string; qtyOrdered: { toString(): string }; orderUom: string; unitPrice: { toString(): string }; discountPct: { toString(): string }; taxPct: { toString(): string } };

export function LineRows({ lines = [], blank = 5 }: { lines?: Line[]; blank?: number }) {
  const rows = [...lines, ...Array.from({ length: blank }, () => null)];
  return (
    <div className="overflow-x-auto">
      <table className="table">
        <thead><tr><th>SKU / barcode</th><th>Qty</th><th>Unit</th><th>Unit price</th><th>Disc %</th><th>Tax %</th></tr></thead>
        <tbody>
          {rows.map((l, i) => (
            <tr key={l?.id ?? `new-${i}`}>
              <td>
                {l && <input type="hidden" name={`line.${i}.id`} value={l.id} />}
                <input name={`line.${i}.sku`} defaultValue={l?.sku} aria-label={`Line ${i + 1} SKU`} className="input w-40 font-mono" />
              </td>
              <td><input name={`line.${i}.qty`} defaultValue={l?.qtyOrdered.toString()} inputMode="decimal" aria-label={`Line ${i + 1} quantity`} className="input w-20" /></td>
              <td><input name={`line.${i}.uom`} defaultValue={l?.orderUom} placeholder="base" aria-label={`Line ${i + 1} unit`} className="input w-20" /></td>
              <td><input name={`line.${i}.unitPrice`} defaultValue={l?.unitPrice.toString()} inputMode="decimal" placeholder="last price" aria-label={`Line ${i + 1} unit price`} className="input w-28" /></td>
              <td><input name={`line.${i}.discountPct`} defaultValue={l?.discountPct.toString()} inputMode="decimal" aria-label={`Line ${i + 1} discount percent`} className="input w-16" /></td>
              <td><input name={`line.${i}.taxPct`} defaultValue={l?.taxPct.toString()} inputMode="decimal" aria-label={`Line ${i + 1} tax percent`} className="input w-16" /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
