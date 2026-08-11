/**
 * @allodium/admin — secret-column masking battery.
 *
 * Two halves. The policy tests are pure and always run, so `npm test` covers them.
 * The bypass battery needs the local dev pg (allodium-dev-pg, :5433) and runs only when
 * DATABASE_URL is set; without it the file reports a skip rather than a pass, because a
 * green run that silently tested nothing is worse than a red one.
 *
 *   DATABASE_URL=postgresql://allodium:localdev@localhost:5433/allodium_dev \
 *     node packages/admin/test/masking.mjs
 *
 * The bypass half is adversarial on purpose: it does not re-check the projection that
 * was already fixed, it tries every OTHER route a secret could take to the caller —
 * write returns, sort, filter, search, relation labels, option lists. Each of those was
 * a separate hole; a test that only asserts the select would have missed all of them.
 */
import { createMaskPolicy, maskedInsertBlockers, createViewResolver } from '../dist/server/index.js';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log('FAIL:', name); } };
const throws = async (name, fn) => {
  try { await fn(); fail++; console.log('FAIL:', name, '(did not throw)'); }
  catch { pass++; }
};

/* ------------------------------ policy ------------------------------ */

{
  const p = createMaskPolicy();

  ok('masks password_hash', p.isMasked('users', 'password_hash'));
  ok('masks mfa_secret', p.isMasked('users', 'mfa_secret'));

  // Substring, not end-anchored — the end-anchored version missed all of these.
  ok('masks password_reset_token_hash', p.isMasked('t', 'password_reset_token_hash'));
  ok('masks secret_key_id', p.isMasked('t', 'secret_key_id'));
  ok('masks api_key_last_used', p.isMasked('t', 'api_key_last_used'));
  ok('masks refresh_token', p.isMasked('t', 'refresh_token'));
  ok('case insensitive', p.isMasked('t', 'PASSWORD_HASH'));

  ok('leaves email alone', !p.isMasked('users', 'email'));
  ok('leaves created_at alone', !p.isMasked('users', 'created_at'));

  // Structural names that trip the pattern but carry nothing secret.
  ok('builtin exempt: mfa_enabled', !p.isMasked('users', 'mfa_enabled'));
  ok('builtin exempt: password_updated_at', !p.isMasked('users', 'password_updated_at'));
  ok('builtin exempt: token_type', !p.isMasked('t', 'token_type'));

  const withExtra = createMaskPolicy({ extra: ['users.ssn', 'internal_note'] });
  ok('extra qualified', withExtra.isMasked('users', 'ssn'));
  ok('extra qualified is table-scoped', !withExtra.isMasked('orders', 'ssn'));
  ok('extra bare applies anywhere', withExtra.isMasked('anything', 'internal_note'));

  const withExempt = createMaskPolicy({ exempt: ['users.mfa_secret'] });
  ok('exempt qualified', !withExempt.isMasked('users', 'mfa_secret'));
  ok('exempt does not leak to other tables', withExempt.isMasked('admins', 'mfa_secret'));

  // Exempt must beat extra — it is the more specific, deliberate decision.
  const both = createMaskPolicy({ extra: ['x.y'], exempt: ['x.y'] });
  ok('exempt beats extra', !both.isMasked('x', 'y'));

  // Thunks, so an app can bind an env var and have it read at call time.
  let spec = [];
  const thunked = createMaskPolicy({ extra: () => spec });
  ok('thunk before', !thunked.isMasked('t', 'colour'));
  spec = ['colour'];
  ok('thunk re-read at call time', thunked.isMasked('t', 'colour'));

  // Comma strings, since that is what an env var actually contains.
  const fromEnv = createMaskPolicy({ extra: () => 'a.b, c' });
  ok('comma string qualified', fromEnv.isMasked('a', 'b'));
  ok('comma string bare', fromEnv.isMasked('z', 'c'));

  ok('insert blockers', JSON.stringify(
    maskedInsertBlockers(
      [
        { name: 'password_hash', nullable: false, hasDefault: false },
        { name: 'mfa_secret', nullable: true, hasDefault: false },
        { name: 'email', nullable: false, hasDefault: false },
      ],
      'users',
      p
    )
  ) === '["password_hash"]');
}

/* ------------------------------ bypass battery ------------------------------ */

const url = process.env.DATABASE_URL;
if (!url) {
  console.log(`policy: ${pass} passed, ${fail} failed`);
  console.log('SKIPPED the bypass battery — set DATABASE_URL to run it against live pg.');
  process.exit(fail === 0 ? 0 : 1);
}

const { Pool } = await import('pg');
const pool = new Pool({ connectionString: url });
const resolver = createViewResolver(pool, { access: 'unrestricted', ttlMs: 0 });

const SECRETS = ['password_hash', 'mfa_secret'];
const hasSecret = (row) => SECRETS.some((s) => s in (row ?? {}));

try {
  await pool.query(`
    drop table if exists _mask_probe_child, _mask_probe;
    create table _mask_probe (
      id serial primary key,
      name text not null,
      api_key text,
      password_hash text
    );
    create table _mask_probe_child (
      id serial primary key,
      label text not null,
      parent_id integer references _mask_probe(id)
    );
    insert into _mask_probe (name, api_key, password_hash)
      values ('alpha', 'ak_live_SECRET', 'pw_SECRET'), ('beta', 'ak_live_OTHER', 'pw_OTHER');
    insert into _mask_probe_child (label, parent_id)
      values ('one', 1), ('two', 2);
  `);

  const probe = { table: '_mask_probe' };

  /* -- reads -- */
  const listed = await resolver.list(probe, { pageSize: 10 });
  ok('list: no api_key', !('api_key' in listed.rows[0]));
  ok('list: no password_hash', !('password_hash' in listed.rows[0]));
  ok('list: keeps visible columns', 'name' in listed.rows[0] && 'id' in listed.rows[0]);

  const readOne = await resolver.read(probe, listed.rows[0].id);
  ok('read: no api_key', !('api_key' in readOne));

  /* -- writes: the `returning *` holes -- */
  const created = await resolver.create(probe, { name: 'gamma' });
  ok('create: no api_key in returned row', !('api_key' in created));
  ok('create: no password_hash in returned row', !('password_hash' in created));
  ok('create: still returns the row', created.name === 'gamma' && created.id != null);

  const updated = await resolver.update(probe, created.id, { name: 'gamma2' });
  ok('update: no api_key in returned row', !('api_key' in updated));
  ok('update: applied the change', updated.name === 'gamma2');

  // The branch that submits nothing writable still returns a row — and used to
  // do it with `select *`.
  const noop = await resolver.update(probe, created.id, {});
  ok('update (no writable values): no api_key', !('api_key' in noop));

  // Writing a masked column must be refused, not silently dropped.
  await throws('create: writing a masked column is refused', () =>
    resolver.create(probe, { name: 'delta', api_key: 'ak_injected' })
  );
  await throws('update: writing a masked column is refused', () =>
    resolver.update(probe, created.id, { api_key: 'ak_injected' })
  );
  const check = await pool.query('select api_key from _mask_probe where id = $1', [created.id]);
  ok('masked column was never written', check.rows[0].api_key === null);

  await resolver.remove(probe, created.id);

  /* -- sort and filter: the oracles -- */
  await throws('filter on a masked column is refused', () =>
    resolver.list(probe, { filters: [{ column: 'api_key', op: 'startsWith', value: 'ak_live_S' }] })
  );

  // Sorting falls back to the default rather than erroring (a stale bookmark should
  // still render) — but it must NOT order by the secret.
  const sorted = await resolver.list({ ...probe, list: { sort: { column: 'id', direction: 'asc' } } }, { sort: 'api_key', direction: 'asc' });
  ok('sort by masked column falls back', sorted.rows[0].name === 'alpha');

  /* -- search: the subtlest one, because searchColumns need not be fields -- */
  const searchable = { table: '_mask_probe', list: { searchColumns: ['api_key'] } };
  const resolvedSearch = await resolver.resolve(searchable);
  ok('masked searchColumn is dropped', !resolvedSearch.list.searchColumns.includes('api_key'));
  ok('masked searchColumn warns', resolvedSearch.warnings.some((w) => w.includes('api_key')));
  const searched = await resolver.list(searchable, { search: 'ak_live_S' });
  ok('search cannot use a masked column as an oracle', searched.total === 2);

  /* -- explicit declaration -- */
  const declared = await resolver.resolve({ table: '_mask_probe', fields: [{ column: 'name' }, { column: 'api_key' }] });
  ok('explicitly declared masked field is dropped', !declared.fields.some((f) => f.key === 'api_key'));
  ok('explicitly declared masked field warns', declared.warnings.some((w) => w.includes('api_key')));

  /* -- relation labels: masking follows the column to the target table -- */
  const child = {
    table: '_mask_probe_child',
    fields: [{ column: 'label' }, { kind: 'relation', column: 'parent_id', relation: { table: '_mask_probe', value: 'id', display: 'api_key' } }],
  };
  const childRows = await resolver.list(child, { pageSize: 10 });
  const label = childRows.rows[0].parent_id__label;
  ok('relation label does not render a masked column', !String(label ?? '').includes('ak_live_'));

  const opts = await resolver.options(child, 'parent_id');
  ok('option labels do not render a masked column', !opts.some((o) => String(o.label).includes('ak_live_')));

  /* -- the escape hatch actually works -- */
  const exempted = createViewResolver(pool, { access: 'unrestricted', ttlMs: 0, masking: { exempt: ['_mask_probe.api_key'] } });
  const exemptedRows = await exempted.list(probe, { pageSize: 1 });
  ok('exempt makes a column visible again', 'api_key' in exemptedRows.rows[0]);
  ok('exempt does not unmask everything', !('password_hash' in exemptedRows.rows[0]));

  /* -- extra config masks a column the pattern would miss -- */
  const strict = createViewResolver(pool, { access: 'unrestricted', ttlMs: 0, masking: { extra: ['_mask_probe.name'] } });
  const strictRows = await strict.list(probe, { pageSize: 1 });
  ok('extra masks a pattern-invisible column', !('name' in strictRows.rows[0]));

  /* -- a masked primary key is unservable, and says so -- */
  const pkMasked = createViewResolver(pool, { access: 'unrestricted', ttlMs: 0, masking: { extra: ['_mask_probe.id'] } });
  await throws('masked primary key throws rather than serving unidentified rows', () =>
    pkMasked.resolve(probe)
  );

  /* -- nothing anywhere -- */
  ok('no secret escaped any read path', !hasSecret(listed.rows[0]) && !hasSecret(readOne) && !hasSecret(created) && !hasSecret(updated));
} finally {
  await pool.query('drop table if exists _mask_probe_child, _mask_probe').catch(() => {});
  await pool.end();
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
