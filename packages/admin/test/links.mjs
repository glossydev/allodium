/**
 * Links out of the admin: a URL template over the row plus a condition.
 *
 * Two things have to hold. The template can never put an unsafe scheme on an
 * operator's screen — not from the file, and not through a row value — and a
 * link must not render for a row it does not apply to or cannot address: a
 * draft is not offered a public address that 404s, an unsaved record with no
 * slug gets no link at all. No database; the format is checked as data.
 */
import { validateViewDefinition, renderLink, linksFor, matchesPredicate, isSafeHref } from '../dist/view.js';

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) pass++;
  else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

console.log('links');

const post = { id: 7, slug: 'the-first-compiler', status: 'published', kind: 'professional', published_at: '2026-09-01T10:00:00.000Z', views: 12 };
const draft = { ...post, id: 8, status: 'draft' };

/* ----------------------------- safe hrefs ----------------------------- */
for (const good of ['/blog/{slug}', '/preview/posts/{id}', 'https://example.com/{slug}', 'HTTP://example.com/x']) ok(`"${good}" is a safe template`, isSafeHref(good));
for (const bad of ['javascript:alert(1)', '//evil.test/{slug}', 'blog/{slug}', 'data:text/html,hi', '{slug}', '', 'mailto:x@y']) ok(`"${bad}" is refused`, !isSafeHref(bad));

const bad = validateViewDefinition({ table: 'posts', links: [{ label: 'x', href: 'javascript:alert(1)' }] });
ok('validation refuses an unsafe href', !bad.ok && bad.problems.some((p) => p.path === 'links[0].href'), JSON.stringify(bad));
ok('validation requires a label', !validateViewDefinition({ table: 'posts', links: [{ href: '/x' }] }).ok);
ok('validation checks the condition', !validateViewDefinition({ table: 'posts', links: [{ label: 'x', href: '/x', when: [{ column: 'status', op: 'roughly', value: 1 }] }] }).ok);
ok('validation checks target', !validateViewDefinition({ table: 'posts', links: [{ label: 'x', href: '/x', target: '_top' }] }).ok);
ok('validation checks in', !validateViewDefinition({ table: 'posts', links: [{ label: 'x', href: '/x', in: ['sidebar'] }] }).ok);
ok('a well-formed link validates', validateViewDefinition({ table: 'posts', links: [{ label: 'View on site', href: '/blog/{slug}', when: [{ column: 'status', value: 'published' }], target: '_blank', in: ['list'] }] }).ok);
ok('the shorthand condition validates', validateViewDefinition({ table: 'posts', links: [{ label: 'x', href: '/x', when: { status: 'published' } }] }).ok);

/* ----------------------------- rendering ------------------------------ */
ok('a placeholder is substituted', renderLink({ label: 'x', href: '/blog/{slug}' }, post) === '/blog/the-first-compiler');
ok('...and URL-encoded', renderLink({ label: 'x', href: '/q/{slug}' }, { slug: 'a b/c?d' }) === '/q/a%20b%2Fc%3Fd');
ok('a value cannot smuggle a scheme', renderLink({ label: 'x', href: '/go/{slug}' }, { slug: 'javascript:alert(1)' }) === '/go/javascript%3Aalert(1)');
ok('a missing placeholder value renders no link', renderLink({ label: 'x', href: '/blog/{slug}' }, { id: 1 }) === null);
ok('an empty placeholder value renders no link', renderLink({ label: 'x', href: '/blog/{slug}' }, { slug: '' }) === null);
ok('a null placeholder value renders no link', renderLink({ label: 'x', href: '/blog/{slug}' }, { slug: null }) === null);
ok('several placeholders', renderLink({ label: 'x', href: '/{kind}/{slug}' }, post) === '/professional/the-first-compiler');
ok('numbers substitute', renderLink({ label: 'x', href: '/preview/{id}' }, post) === '/preview/7');
ok('an unsafe template renders nothing even with a row', renderLink({ label: 'x', href: 'javascript:{slug}' }, post) === null);

/* ------------------------------ conditions ------------------------------ */
const published = { label: 'View on site', href: '/blog/{slug}', when: [{ column: 'status', value: 'published' }] };
ok('a condition that holds renders', renderLink(published, post) !== null);
ok('a condition that fails renders nothing', renderLink(published, draft) === null);
ok('the shorthand condition works', renderLink({ ...published, when: { status: 'published' } }, draft) === null);
ok('a routed link: kind decides the path', renderLink({ label: 'x', href: '/portfolio/{slug}', when: [{ column: 'kind', value: 'professional' }] }, post) === '/portfolio/the-first-compiler');
ok('...and the other kind gets the other link', renderLink({ label: 'x', href: '/portfolio/{slug}', when: [{ column: 'kind', value: 'professional' }] }, { ...post, kind: 'playground' }) === null);
ok('conditions AND', renderLink({ label: 'x', href: '/x', when: [{ column: 'status', value: 'published' }, { column: 'views', op: 'gt', value: 100 }] }, post) === null);

// The client-side predicate mirrors the SQL one.
const m = (p, row) => matchesPredicate(p, row);
ok('eq compares as text', m({ column: 'id', value: '7' }, post) && m({ column: 'id', value: 7 }, post));
ok('eq is false of null', !m({ column: 'x', value: 'a' }, { x: null }));
ok('ne is true of null (IS DISTINCT FROM)', m({ column: 'x', op: 'ne', value: 'a' }, { x: null }));
ok('null means isNull', m({ column: 'x', value: null }, { x: null }) && !m({ column: 'x', value: null }, { x: 1 }));
ok('notNull', m({ column: 'x', op: 'notNull' }, { x: 0 }) && !m({ column: 'x', op: 'notNull' }, {}));
ok('an array means in', m({ column: 'status', value: ['draft', 'published'] }, post) && !m({ column: 'status', value: ['draft'] }, post));
ok('contains is case-insensitive', m({ column: 'slug', op: 'contains', value: 'FIRST' }, post));
ok('startsWith / endsWith', m({ column: 'slug', op: 'startsWith', value: 'the-' }, post) && m({ column: 'slug', op: 'endsWith', value: 'compiler' }, post));
ok('gt compares numbers as numbers', m({ column: 'views', op: 'gt', value: 9 }, post) && !m({ column: 'views', op: 'gt', value: '100' }, post));
ok('...not as text', m({ column: 'views', op: 'lt', value: 100 }, { views: 12 }));
ok('gte / lte are inclusive', m({ column: 'views', op: 'gte', value: 12 }, post) && m({ column: 'views', op: 'lte', value: 12 }, post));
ok('ordered comparisons on dates use text order', m({ column: 'published_at', op: 'lt', value: '2026-10-01' }, post) && !m({ column: 'published_at', op: 'gt', value: '2026-10-01' }, post));
ok('ordered comparisons are false of null', !m({ column: 'x', op: 'gt', value: 1 }, { x: null }));

/* ------------------------------ placement ------------------------------ */
const links = [
  { label: 'View on site', href: '/blog/{slug}', when: [{ column: 'status', value: 'published' }], target: '_blank' },
  { label: 'Preview', href: '/preview/posts/{id}', in: ['form'] },
  { label: 'Stats', href: '/stats/{id}', in: ['list'] },
];
const inList = linksFor(links, post, 'list');
const inForm = linksFor(links, post, 'form');
ok('a list gets the links placed there', inList.map((l) => l.label).join(',') === 'View on site,Stats', JSON.stringify(inList));
ok('a form gets the links placed there', inForm.map((l) => l.label).join(',') === 'View on site,Preview', JSON.stringify(inForm));
ok('target defaults to the same tab', inForm.find((l) => l.label === 'Preview')?.target === '_self');
ok('...and is carried when set', inList.find((l) => l.label === 'View on site')?.target === '_blank');
ok('a draft loses the conditional link but keeps the rest', linksFor(links, draft, 'form').map((l) => l.label).join(',') === 'Preview');
ok('no links is an empty list', linksFor(undefined, post, 'list').length === 0 && linksFor([], post, 'form').length === 0);
ok('an unsaved record with no slug gets nothing addressable', linksFor(links, {}, 'form').length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
