/**
 * The JSON Schema shipped for `.view.json` files must keep describing the same
 * format `src/view.ts` defines.
 *
 * That pairing is the whole hazard. A schema is a SECOND declaration of the
 * format, and the moment it drifts it starts lying — an editor marks a valid
 * file invalid, or worse, silently accepts a key the runtime ignores. Nothing
 * in a build catches that, because neither file imports the other.
 *
 * So this reads the TypeScript as text and checks the two agree on every
 * property name and every widget enum. No dependencies, no test framework: run
 * it with `node`, same as the auth battery.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(here, '..', 'src', 'view.ts'), 'utf8');
const SCHEMA = JSON.parse(readFileSync(path.join(here, '..', 'view.schema.json'), 'utf8'));

let pass = 0;
let fail = 0;

function check(name, cond, detail = '') {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** Top-level property names of an interface, read straight out of the source. */
function propsOf(iface) {
  const m = SRC.match(new RegExp(`(?:export )?interface ${iface}[^{]*\\{([\\s\\S]*?)\\n\\}`));
  if (!m) throw new Error(`interface ${iface} not found in view.ts — did it get renamed?`);
  // Exactly two spaces of indent: nested object literals sit deeper, and JSDoc
  // lines start with * which is not a word character.
  return new Set([...m[1].matchAll(/^ {2}(\$?\w+)\??:/gm)].map((x) => x[1]));
}

/**
 * The string-literal union on one property, e.g. widget?: 'text' | 'number'.
 * Reads to end of line rather than to the first semicolon — an inline object
 * like `sort?: { column: string; direction?: 'asc' | 'desc' }` has semicolons
 * of its own, and stopping at one silently returns an empty set.
 */
function unionOf(iface, prop) {
  const body = SRC.match(new RegExp(`(?:export )?interface ${iface}[^{]*\\{([\\s\\S]*?)\\n\\}`))[1];
  const line = body.match(new RegExp(`^ {2}${prop}\\??:(.*)$`, 'm'));
  if (!line) throw new Error(`${iface}.${prop} not found`);
  const values = [...line[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  if (!values.length) throw new Error(`${iface}.${prop} has no string-literal union — the guard would pass vacuously`);
  return new Set(values);
}

const setEq = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
const only = (a, b) => [...a].filter((x) => !b.has(x));

/** Compare an interface's properties against a schema object's `properties`. */
function comparePropsg(label, tsProps, schemaObj) {
  const schemaProps = new Set(Object.keys(schemaObj.properties ?? {}));
  const missing = only(tsProps, schemaProps);
  const extra = only(schemaProps, tsProps);
  check(
    `${label}: properties match`,
    missing.length === 0 && extra.length === 0,
    [missing.length ? `absent from schema: ${missing.join(', ')}` : '', extra.length ? `absent from view.ts: ${extra.join(', ')}` : '']
      .filter(Boolean)
      .join('; ')
  );
}

console.log('view.schema.json ↔ src/view.ts');

/* ---------------------------- the document ---------------------------- */

comparePropsg('ViewDefinition', propsOf('ViewDefinition'), SCHEMA);
comparePropsg('ListOptions', propsOf('ListOptions'), SCHEMA.definitions.list);
comparePropsg('RelatedList', propsOf('RelatedList'), SCHEMA.definitions.relatedList);
comparePropsg('ViewLink', propsOf('ViewLink'), SCHEMA.definitions.link);

/* ------------------------------ the fields ---------------------------- */

// Every field variant carries FieldCommon's properties too, and the schema
// inlines them per variant so `additionalProperties: false` stays usable.
const common = propsOf('FieldCommon');
const union = (a, b) => new Set([...a, ...b]);

comparePropsg('ColumnField + common', union(propsOf('ColumnField'), common), SCHEMA.definitions.columnField);
comparePropsg('RelationField + common', union(propsOf('RelationField'), common), SCHEMA.definitions.relationField);
comparePropsg('ManyToManyField + common', union(propsOf('ManyToManyField'), common), SCHEMA.definitions.m2mField);

// The nested relation object is its own shape.
const relationInner = new Set(
  [...SRC.match(/interface RelationField[\s\S]*?\n {2}relation: \{([\s\S]*?)\n {2}\};/)[1].matchAll(/^ {4}(\w+)\??:/gm)].map((x) => x[1])
);
comparePropsg('RelationField.relation', relationInner, SCHEMA.definitions.relationField.properties.relation);

/* ------------------------------ the enums ----------------------------- */

const enumOf = (obj) => new Set(obj.enum ?? []);

check(
  'ColumnField.widget values match',
  setEq(unionOf('ColumnField', 'widget'), enumOf(SCHEMA.definitions.columnField.properties.widget)),
  `view.ts: ${[...unionOf('ColumnField', 'widget')].join('|')}`
);
check(
  'RelationField.widget values match',
  setEq(unionOf('RelationField', 'widget'), enumOf(SCHEMA.definitions.relationField.properties.widget))
);
check(
  'ManyToManyField.widget values match',
  setEq(unionOf('ManyToManyField', 'widget'), enumOf(SCHEMA.definitions.m2mField.properties.widget))
);
check(
  'FieldCommon.in values match',
  setEq(unionOf('FieldCommon', 'in'), enumOf(SCHEMA.definitions.in.items))
);
check(
  'ListOptions.sort.direction values match',
  setEq(unionOf('ListOptions', 'sort'), enumOf(SCHEMA.definitions.list.properties.sort.properties.direction))
);
check('ViewLink.target values match', setEq(unionOf('ViewLink', 'target'), enumOf(SCHEMA.definitions.link.properties.target)));
check('ViewLink.in values match', setEq(unionOf('ViewLink', 'in'), enumOf(SCHEMA.definitions.link.properties.in.items)));
// The schema's href pattern and view.ts's isSafeHref are the same rule declared
// twice, so hold them to the same verdicts.
{
  const pattern = new RegExp(SCHEMA.definitions.link.properties.href.pattern);
  const safe = (h) => /^(\/(?!\/)|https?:\/\/)/i.test(h);
  const cases = ['/blog/{slug}', 'https://x.test/{id}', 'HTTP://x', '//evil', 'javascript:alert(1)', 'blog/x', 'data:x', ''];
  check('link.href pattern agrees with isSafeHref', cases.every((c) => pattern.test(c) === safe(c)), cases.filter((c) => pattern.test(c) !== safe(c)).join(', '));
}

/* --------------------------- structural sanity -------------------------- */

check("root requires 'table'", JSON.stringify(SCHEMA.required) === '["table"]');
check('root rejects unknown keys', SCHEMA.additionalProperties === false);
for (const v of ['columnField', 'relationField', 'm2mField', 'list', 'relatedList', 'link']) {
  check(`${v} rejects unknown keys`, SCHEMA.definitions[v].additionalProperties === false);
}
check("relatedList requires table + foreignKey", JSON.stringify(SCHEMA.definitions.relatedList.required) === '["table","foreignKey"]');
check('field is a 3-branch oneOf', SCHEMA.definitions.field.oneOf?.length === 3);
check(
  'relation/m2m are discriminated by a const kind',
  SCHEMA.definitions.relationField.properties.kind.const === 'relation' &&
    SCHEMA.definitions.m2mField.properties.kind.const === 'm2m' &&
    SCHEMA.definitions.columnField.properties.kind.const === 'column'
);
// A column field's `kind` is optional in view.ts — requiring it here would mark
// every `{ "column": "title" }` in every existing file invalid.
check("columnField does not require 'kind'", !(SCHEMA.definitions.columnField.required ?? []).includes('kind'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
