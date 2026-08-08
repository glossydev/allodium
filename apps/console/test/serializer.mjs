/**
 * The .view.json round trip.
 *
 * A definition passes through two serializers on its way back to disk — the
 * editor's `draftToDefinition` and the writer's `pruneDefaults` — and either one
 * dropping a key it does not model is silent data loss: no error, and a `git
 * diff` that looks like the edit you meant to make.
 *
 * So this asserts the property that matters rather than the current key list:
 * anything present on the way in is still present on the way out, INCLUDING keys
 * neither serializer has been taught. Run with plain node (type stripping).
 */
import { pruneDefaults } from '../lib/view-serialize.ts';
import { draftToDefinition } from '../app/admin-builder/types.ts';

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) pass++;
  else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

console.log('.view.json round trip');

/** A definition using keys the editor has no control for. */
const onDisk = {
  table: 'orders',
  title: 'Customer Orders',
  primaryKey: 'order_number',
  display: '{order_number}',
  fields: [
    { column: 'order_number' },
    { column: 'total', label: 'Order Total' },
    { kind: 'relation', column: 'customer_id', relation: { table: 'customers', display: 'name', filter: { archived: false } } },
  ],
  list: {
    columns: ['order_number', 'total'],
    pageSize: 50,
    sort: { column: 'total', direction: 'desc' },
    searchColumns: ['order_number'],
    filter: [{ column: 'total', op: 'gt', value: 0 }],
  },
};

/** The draft the editor would hold for it — only the parts it models. */
const draftFor = (def) => ({
  name: 'orders',
  table: def.table,
  title: def.title ?? '',
  description: def.description ?? '',
  display: def.display ?? '',
  fields: (def.fields ?? []).map((f) => ({ include: true, field: f })),
  listColumns: def.list?.columns ?? [],
  pageSize: def.list?.pageSize ?? 25,
  searchColumns: def.list?.searchColumns ?? [],
  related: def.related ?? [],
  implicitFields: !def.fields,
  source: def,
});

/* ----------------------- related panels ---------------------------- */
{
  const withPanels = {
    ...onDisk,
    related: [
      { table: 'orders', foreignKey: 'customer_id' },
      { table: 'invoices', foreignKey: 'customer_id', title: 'Unpaid', view: 'invoices-unpaid', pageSize: 10 },
    ],
  };
  const out = pruneDefaults(draftToDefinition(draftFor(withPanels)));
  ok('panels survive the round trip', out.related?.length === 2);
  ok('a bare panel keeps only what was chosen', JSON.stringify(out.related[0]) === JSON.stringify({ table: 'orders', foreignKey: 'customer_id' }));
  ok('a customised panel keeps its overrides', out.related[1].title === 'Unpaid' && out.related[1].view === 'invoices-unpaid' && out.related[1].pageSize === 10);

  // Defaults the runtime recomputes are not written back — the same rule that
  // strips a title equal to humanize(table).
  const defaulted = pruneDefaults({ table: 'customers', related: [{ table: 'orders', foreignKey: 'customer_id', view: 'orders', pageSize: 5 }] });
  ok('a view equal to the table name is stripped', defaulted.related[0].view === undefined);
  ok('a default pageSize is stripped', defaulted.related[0].pageSize === undefined);

  // Removing the last panel removes the key rather than leaving [].
  const cleared = draftToDefinition({ ...draftFor(withPanels), related: [] });
  ok('clearing every panel drops the key', !('related' in cleared));
}

/* ------------------- the editor's half: open, save ------------------- */
{
  const out = draftToDefinition(draftFor(onDisk));
  ok('primaryKey survives the editor', out.primaryKey === 'order_number');
  ok('list.sort survives the editor', out.list?.sort?.column === 'total' && out.list?.sort?.direction === 'desc');
  ok('list.filter survives the editor', JSON.stringify(out.list?.filter) === JSON.stringify(onDisk.list.filter));
  ok('relation.filter survives the editor', JSON.stringify(out.fields[2].relation.filter) === JSON.stringify({ archived: false }));
  ok('the editor still owns what it models', out.list.pageSize === 50 && out.title === 'Customer Orders');
}

/* -------------------- the writer's half: prune ---------------------- */
{
  const out = pruneDefaults(onDisk);
  ok('primaryKey survives pruning', out.primaryKey === 'order_number');
  ok('list.sort survives pruning', out.list?.sort?.column === 'total');
  ok('list.filter survives pruning', JSON.stringify(out.list?.filter) === JSON.stringify(onDisk.list.filter));
  ok('relation.filter survives pruning', JSON.stringify(out.fields[2].relation.filter) === JSON.stringify({ archived: false }));
  ok('pruning still strips an inferable title', pruneDefaults({ table: 'orders', title: 'Orders' }).title === undefined);
  ok('pruning still strips a default pageSize', pruneDefaults({ table: 'o', list: { pageSize: 25 } }).list === undefined);
}

/* ------------- the whole trip, including keys nobody knows ----------- */
{
  // The real guarantee: a key added to the format later, that neither serializer
  // has been taught, still makes it back to disk.
  const future = {
    ...onDisk,
    someFutureKey: { enabled: true },
    fields: [{ column: 'total', sortable: false }],
    list: { ...onDisk.list, someFutureListKey: 42 },
  };
  const out = pruneDefaults(draftToDefinition(draftFor(future)));

  ok('unknown ROOT key survives both', JSON.stringify(out.someFutureKey) === '{"enabled":true}');
  ok('unknown LIST key survives both', out.list?.someFutureListKey === 42);
  ok('unknown FIELD key survives both', out.fields?.[0]?.sortable === false);
  ok('known keys still correct after both', out.primaryKey === 'order_number' && out.list?.sort?.column === 'total');
}

/* ------------------------- edits still apply ------------------------ */
{
  const d = draftFor(onDisk);
  d.title = '';                                  // cleared in the UI
  d.fields = d.fields.filter((f) => f.field.column !== 'total');
  const out = draftToDefinition(d);
  ok('clearing a text box unsets the key', out.title === undefined);
  ok('removing a field removes it', !out.fields.some((f) => f.column === 'total'));
  ok('a sort naming a removed field is dropped', out.list?.sort === undefined);
  ok('list.columns drops the removed field', !out.list.columns.includes('total'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
