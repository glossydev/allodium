/**
 * Directus permission filters → Allodium row-filter predicates.
 *
 * Allodium's predicate list is flat and AND-only, and a grant's filter is checked
 * server-side on every read and after every write — so a translation that is not
 * exact is worse than none. This translator therefore refuses rather than
 * approximates: anything it cannot express comes back as a reason, and the caller
 * leaves that grant OUT (fail closed) for a person to decide.
 *
 * What does translate:
 *   { col: { _eq: v } }              → { column: 'col', op: 'eq', value: v }
 *   { rel: { col: { _eq: v } } }     → { column: 'rel.col', … }  (an FK path; the grant loader walks it)
 *   { _and: [ … ] }                  → the concatenation
 *   $CURRENT_USER                    → '$actor.userId'
 *   $CURRENT_ROLE                    → refused (Allodium grants are already per role)
 *   _or, _ncontains, _nin, _between, _empty, _regex, $NOW, $CURRENT_USER.<field> → refused
 */
import type { Predicate } from './types.js';

export class UntranslatableFilter extends Error {
  constructor(message: string, public readonly at: string) {
    super(message);
    this.name = 'UntranslatableFilter';
  }
}

type Scalar = string | number | boolean | null;

const OPS: Record<string, Predicate['op']> = {
  _eq: 'eq',
  _neq: 'ne',
  _lt: 'lt',
  _lte: 'lte',
  _gt: 'gt',
  _gte: 'gte',
  _in: 'in',
  _contains: 'contains',
  _icontains: 'contains',
  _starts_with: 'startsWith',
  _istarts_with: 'startsWith',
  _ends_with: 'endsWith',
  _iends_with: 'endsWith',
  _null: 'isNull',
  _nnull: 'notNull',
};

function dynamic(v: unknown, at: string): Scalar | Scalar[] {
  if (Array.isArray(v)) return v.map((x) => dynamic(x, at) as Scalar);
  if (typeof v === 'string' && v.startsWith('$')) {
    if (v === '$CURRENT_USER') return '$actor.userId';
    if (v.startsWith('$CURRENT_USER.')) throw new UntranslatableFilter(`${v}: a claim off the current user — add it to the actor's claims and use $actor.<claim>`, at);
    if (v === '$CURRENT_ROLE' || v.startsWith('$CURRENT_ROLE')) throw new UntranslatableFilter(`${v}: Allodium grants are already per role; drop this clause from the per-role grant`, at);
    if (v.startsWith('$CURRENT_POLICIES')) throw new UntranslatableFilter(`${v}: policies do not exist in Allodium`, at);
    if (v.startsWith('$NOW')) throw new UntranslatableFilter(`${v}: no time-relative predicate — express it as a column the app maintains`, at);
    throw new UntranslatableFilter(`unknown dynamic variable ${v}`, at);
  }
  if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  throw new UntranslatableFilter(`unsupported value ${JSON.stringify(v)}`, at);
}

/**
 * Translate one Directus filter object. Throws UntranslatableFilter with the path of
 * the offending clause. `{}` and null mean "every row" and translate to `[]`.
 */
export function translateFilter(filter: unknown, at = '$'): Predicate[] {
  if (filter === null || filter === undefined) return [];
  if (typeof filter !== 'object' || Array.isArray(filter)) throw new UntranslatableFilter('filter must be an object', at);
  const out: Predicate[] = [];
  for (const [key, value] of Object.entries(filter as Record<string, unknown>)) {
    const here = `${at}.${key}`;
    if (key === '_and') {
      if (!Array.isArray(value)) throw new UntranslatableFilter('_and needs an array', here);
      value.forEach((v, i) => out.push(...translateFilter(v, `${here}[${i}]`)));
      continue;
    }
    if (key === '_or') {
      if (Array.isArray(value) && value.length === 1) {
        out.push(...translateFilter(value[0], `${here}[0]`));
        continue;
      }
      throw new UntranslatableFilter('_or: Allodium predicates are AND-only — split this into two roles, or restate it as one condition', here);
    }
    if (key.startsWith('_')) throw new UntranslatableFilter(`operator ${key} at the top level has no column`, here);
    out.push(...translateColumn([key], value, here));
  }
  return out;
}

function translateColumn(path: string[], value: unknown, at: string): Predicate[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    // Directus accepts the shorthand { col: v } meaning _eq.
    return [{ column: path.join('.'), op: 'eq', value: dynamic(value, at) as Scalar }];
  }
  const entries = Object.entries(value as Record<string, unknown>);
  const out: Predicate[] = [];
  for (const [key, v] of entries) {
    const here = `${at}.${key}`;
    if (!key.startsWith('_')) {
      // Nested: a relation hop. Alias fields (o2m/m2m) cannot be walked as an FK path;
      // the grant loader only follows FK columns. We cannot tell here, so the caller
      // checks the path against the inventory.
      out.push(...translateColumn([...path, key], v, here));
      continue;
    }
    if (key === '_and' || key === '_or') throw new UntranslatableFilter(`${key} inside a column clause`, here);
    const op = OPS[key];
    if (!op) {
      const hint =
        key === '_nin' ? 'no "not in" operator — invert the condition or split the role'
        : key === '_ncontains' || key === '_nstarts_with' || key === '_nends_with' ? 'negated text matching is not available'
        : key === '_between' || key === '_nbetween' ? 'use two predicates (gte and lte)'
        : key === '_empty' || key === '_nempty' ? 'use _null/_nnull, or compare to ""'
        : key === '_intersects' || key === '_regex' ? 'not available'
        : 'not available';
      throw new UntranslatableFilter(`${key}: ${hint}`, here);
    }
    const column = path.join('.');
    if (op === 'isNull' || op === 'notNull') {
      // { _null: true } means IS NULL; { _null: false } means IS NOT NULL.
      const flag = v === undefined ? true : v;
      if (flag !== true && flag !== false) throw new UntranslatableFilter(`${key} takes true or false`, here);
      out.push({ column, op: (op === 'isNull') === (flag === true) ? 'isNull' : 'notNull' });
      continue;
    }
    const val = dynamic(v, here);
    if (op === 'in') {
      if (!Array.isArray(val)) throw new UntranslatableFilter('_in needs an array', here);
      out.push({ column, op, value: val });
      continue;
    }
    if (Array.isArray(val)) throw new UntranslatableFilter(`${key} does not take an array`, here);
    out.push({ column, op, value: val });
  }
  return out;
}
