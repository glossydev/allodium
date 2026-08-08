import type { ViewDefinition } from '@allodium/admin/view';

/**
 * Which definition a caller that knows its TABLE should render.
 *
 * Pure on purpose — no filesystem, no `server-only` — so the rule can be tested
 * by running it. The I/O half lives in ./views.
 *
 * ## Why the table decides
 *
 * A related panel addresses a table: `post_tags`, taken from the catalog and
 * validated against it. The view name is only what somebody called a file. Those
 * are two namespaces — one written by the schema, one by hand — and nothing kept
 * them in step.
 *
 * A file named `post_tags.view.json` containing a view of `tags` satisfied a
 * lookup by name, rendered the wrong table, and failed on the first bound filter
 * with "Cannot filter on post_id": a 404 traded for a 400, with nothing pointing
 * at the mismatch. Matching on the name was never what made the panel correct.
 *
 * So: the named file only if it really is about this table, else any view that
 * is, preferring one named after it, else the implicit screen. That last step
 * matters as much as the first — "omission means the sensible default, never
 * off" applies here too, so a table with no curated view gets a plain screen
 * rather than an error.
 */
export function pickViewForTable(
  named: ViewDefinition | null,
  all: { name: string; definition: ViewDefinition }[],
  table: string
): ViewDefinition {
  if (named && named.table === table) return named;

  const preferred = all.find((v) => v.definition.table === table && v.name === table);
  const anyMatch = preferred ?? all.find((v) => v.definition.table === table);
  if (anyMatch) return anyMatch.definition;

  return { table };
}
