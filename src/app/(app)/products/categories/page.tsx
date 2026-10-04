import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/app/ui/action-form";
import { Denied } from "@/app/ui/denied";
import { pageData } from "@/server/auth/page-ctx";
import { listCategories } from "@/server/catalog/taxonomy";
import { archiveCategoryAction, createCategoryAction, mergeCategoryAction, updateCategoryAction } from "../actions";

export const metadata: Metadata = { title: "Categories" };

const indent = (depth: number) => "   ".repeat(depth - 1);

export default async function CategoriesPage() {
  const res = await pageData(async (ctx) => ({
    categories: await listCategories(ctx, { includeArchived: true }),
    canManage: ctx.permissions.has("categories.manage"),
  }));
  if ("denied" in res) return <Denied message={res.denied} />;
  const { categories, canManage } = res.data;
  const active = categories.filter((c) => !c.archived);
  const options = (exclude?: string) => active.filter((c) => !exclude || !c.path.startsWith(categories.find((x) => x.id === exclude)!.path))
    .map((c) => <option key={c.id} value={c.id}>{indent(c.depth)}{c.name}</option>);

  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <div>
        <Link href="/products" className="link text-sm">← Products</Link>
        <h1 className="h1 mt-1">Categories</h1>
        <p className="text-sm text-muted">Up to 5 levels. Archiving needs the category (and its subcategories) to be empty; merging moves the products and archives the merged one.</p>
      </div>

      <div className="card overflow-x-auto p-0">
        <table className="table">
          <thead><tr><th>Category</th><th className="text-right">Products</th>{canManage && <th>Rename / move</th>}{canManage && <th />}</tr></thead>
          <tbody>
            {categories.length === 0 && <tr><td colSpan={4} className="text-muted">No categories yet.</td></tr>}
            {categories.map((c) => (
              <tr key={c.id} className={c.archived ? "text-muted" : undefined}>
                <td className="whitespace-nowrap">{indent(c.depth)}{c.name}{c.archived && " (archived)"}</td>
                <td className="text-right tabular-nums">{c._count.products}</td>
                {canManage && (
                  <td>
                    {!c.archived && (
                      <ActionForm action={updateCategoryAction.bind(null, c.id)} submit="Save" className="flex flex-wrap items-end gap-2">
                        <input type="hidden" name="version" value={c.version} />
                        <input name="name" aria-label="Name" defaultValue={c.name} required className="input w-40" />
                        <select name="parentId" aria-label="Parent" defaultValue={c.parentId ?? ""} className="input w-48">
                          <option value="">(top level)</option>
                          {options(c.id)}
                        </select>
                      </ActionForm>
                    )}
                  </td>
                )}
                {canManage && (
                  <td>
                    <ActionForm action={archiveCategoryAction.bind(null, c.id, !c.archived)} submit={c.archived ? "Re-activate" : "Archive"}>
                      <input type="hidden" name="version" value={c.version} />
                    </ActionForm>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {canManage && (
        <div className="grid gap-6 md:grid-cols-2">
          <section className="card">
            <h2 className="mb-3 font-semibold">New category</h2>
            <ActionForm action={createCategoryAction} submit="Create">
              <label className="label">Name<input name="name" required maxLength={100} className="input" /></label>
              <label className="label">Parent<select name="parentId" className="input"><option value="">(top level)</option>{options()}</select></label>
            </ActionForm>
          </section>
          <section className="card">
            <h2 className="mb-3 font-semibold">Merge</h2>
            <ActionForm action={mergeCategoryAction} submit="Merge">
              <label className="label">Move all products from<select name="fromId" className="input">{options()}</select></label>
              <label className="label">into<select name="intoId" className="input">{options()}</select></label>
            </ActionForm>
          </section>
        </div>
      )}
    </div>
  );
}
