import { readFileSync, writeFileSync } from 'node:fs';
const DIR = process.argv[2];
const imgs = JSON.parse(readFileSync(`${DIR}/imgs.json`, 'utf8'));

/** Figure with a caption. Screenshots break out of the prose column. */
const fig = (key, caption) => `
<figure>
  <div class="shot"><img src="${imgs[key]}" alt="${caption.replace(/"/g, '&quot;')}" /></div>
  <figcaption>${caption}</figcaption>
</figure>`;

const HEAD = `<title>The Allodium developer console</title>`;

const BODY = `
<a class="skip" href="#main">Skip to content</a>

<div class="shell">
<aside class="rail">
  <div class="brand">
    <span class="wordmark">allodium<span class="cursor">_</span></span>
    <span class="sub">developer console</span>
  </div>
  <nav aria-label="Contents">
    <a href="#intro">Overview</a>
    <a href="#running">Running it</a>
    <p class="railhead">The seven silos</p>
    <a href="#schema"><span class="dot"></span>Schema</a>
    <a href="#content"><span class="dot"></span>Content</a>
    <a href="#users"><span class="dot"></span>Users</a>
    <a href="#roles"><span class="dot"></span>Roles &amp; Permissions</a>
    <a href="#files"><span class="dot"></span>Files</a>
    <a href="#sql"><span class="dot"></span>SQL</a>
    <a href="#builder"><span class="dot"></span>Admin Builder</a>
    <p class="railhead">Reference</p>
    <a href="#safety">Safety model</a>
    <a href="#trouble">Troubleshooting</a>
  </nav>
</aside>

<main id="main">

<header class="masthead">
  <p class="eyebrow">Documentation</p>
  <h1>The developer console</h1>
  <p class="lede">The lane for <em>building</em> the site: scaffold and alter schema, browse and edit
  data, manage roles, run read-only SQL — and generate the admin screens that the people
  running the business will actually use.</p>
  <p class="meta">Runs at <code>localhost:3180</code> · loopback only · no authentication in v1</p>
</header>

<section id="intro">
  <h2>Two lanes, and why this one is separate</h2>
  <p>Most CMS admin panels make one interface serve two very different people: the developer
  building the site, and the person running it. Serving both badly is why they end up tedious
  for one and confusing for the other.</p>
  <p>Allodium splits them. This console is the <strong>build lane</strong> — dense, fast, and
  unapologetically technical. The <strong>run lane</strong> is a separate admin dashboard made
  of friendly guided screens, and the console generates it. That is the mechanic the whole
  design is arranged around.</p>
  <div class="note">
    <p><strong>The console is not the admin panel your team uses.</strong> It is the tool you
    use to build that panel. It shows raw tables, real SQL types and a SQL console; it assumes
    you know what a foreign key is.</p>
  </div>
</section>

<section id="running">
  <h2>Running it</h2>
  <p>The console is not published to npm yet — you run it from the repository.</p>
  <pre><code>git clone https://github.com/glossydev/allodium.git
cd allodium
npm install
npm run build          <span class="c"># the console imports the packages from dist/</span>

cd apps/console
cp .env.example .env.local
<span class="c"># edit DATABASE_URL to point at your Postgres</span>
npm run dev</code></pre>
  <p>Open <a href="http://localhost:3180"><code>http://localhost:3180</code></a>. Getting started
  has a one-line Docker command for a database and a sample dataset built to exercise every
  kind of column an admin tool has to render.</p>
  <div class="warn">
    <p><strong><code>http://127.0.0.1:3180</code> will not answer.</strong> The console binds
    <code>localhost</code>, which resolves to the IPv6 loopback. Use <code>localhost</code> or
    <code>[::1]</code>. This is deliberate — see <a href="#safety">the safety model</a>.</p>
  </div>
</section>

<section id="schema">
  <h2><span class="silo">Schema</span></h2>
  <p>The live truth of your database, and the tools to change it. Every table with its row
  count, size, column count and foreign-key degree — select one for the detail pane.</p>
  ${fig('schema', 'The Schema silo. Left: every table with rows, size and foreign-key degree. Right: the selected table’s columns, what references it, and its indexes.')}
  <p>Column descriptions appear under each name because documentation is most useful while you
  are scanning. Click a column name to edit it.</p>

  <h3>Changing things</h3>
  <p>Everything the builder does previews its SQL before running, and any failure surfaces
  Postgres’s own error — including the <code>DETAIL</code> and <code>HINT</code> lines, which
  carry the part that tells you what to do.</p>
  <table class="ref">
    <thead><tr><th>Action</th><th>What it does</th></tr></thead>
    <tbody>
      <tr><td>New table</td><td>Columns, types, defaults, primary keys — <em>and foreign keys inline</em>, declared while you create the table.</td></tr>
      <tr><td>Column editor</td><td>Rename, change type, toggle nullability, set a default, write a description. Four independent operations, each with its own preview and Apply.</td></tr>
      <tr><td>Foreign key</td><td>Three entry points: inline at create time, a table-level button, or per-column.</td></tr>
      <tr><td>Index</td><td>Ordered column list — order matters for composite b-trees — with optional uniqueness.</td></tr>
      <tr><td>Join table</td><td>A many-to-many between two tables, with FK types derived from the real primary keys.</td></tr>
      <tr><td>Types</td><td>Create enum types, add and rename values.</td></tr>
    </tbody>
  </table>

  <h3>The foreign-key builder</h3>
  <p>Pick a column, pick a table, pick the column it references, choose what happens when the
  referenced row is deleted. The SQL builds as you choose.</p>
  ${fig('fk-builder', 'The foreign-key builder. Only primary-key and unique columns are offered as targets, because Postgres accepts nothing else — and each on-delete behaviour is explained in plain language.')}
  <p>Two details worth knowing. Only <strong>primary-key and unique columns</strong> appear as
  targets, since offering anything else would just manufacture a rejected statement. And if the
  source and target types cannot form a foreign key, it says so <em>before</em> you run it
  rather than after.</p>

  <h3>Enum types</h3>
  ${fig('types', 'The Types surface. Each enum shows its values in definition order and which columns use it; a type in use cannot be dropped.')}
  <div class="note">
    <p><strong>Postgres has no <code>DROP VALUE</code>.</strong> An enum value can be added or
    renamed, never removed. Definition order is also sort order for <code>ORDER BY</code> on an
    enum column, which is why new values can be inserted before an existing one rather than only
    appended. The footer says all of this, so you learn it here rather than from a failure.</p>
  </div>

  <h3>Descriptions are schema, not app config</h3>
  <p>A column’s description is stored as a Postgres <code>COMMENT</code>. It travels with the
  column — visible in <code>psql</code> and every other tool, surviving dump and restore — and
  the admin runtime uses it as the default help text on any screen showing that field. Describe
  a field once, in the schema, and every screen inherits it.</p>
</section>

<section id="content">
  <h2><span class="silo">Content</span></h2>
  <p>Generic CRUD over any table in the database, with no per-table configuration. A table
  created a minute ago is browsable here, because the console reads the catalog rather than a
  registry that has to be kept in step.</p>
  ${fig('content-peek', 'The Content browser with a foreign-key peek open. Hovering the arrow beside category_id shows the row on the other end — without leaving the grid.')}

  <h3>Foreign keys you can see through</h3>
  <p>Every foreign-key value carries an arrow. Click it to jump to the referenced row filtered;
  <strong>hover it</strong> and a card shows what is actually over there. Which columns appear is
  decided server-side by heuristic — the referenced column, then the most name-like column, then
  enums and booleans — so it is useful without any setup.</p>
  <p>It is cheap by construction: one indexed lookup, a cache keyed by value so re-hovering a
  repeated id is free, and a hover delay so sweeping the mouse across a grid fires nothing.</p>

  <h3>Editing rows</h3>
  ${fig('content-drawer', 'The row drawer. Widgets follow the column type, and foreign keys get a searchable picker rather than a box you type an id into.')}
  <p>The drawer picks a widget from the column’s type — a select for enums, a checkbox for
  booleans, a textarea for JSON, a line-per-item list for arrays. Foreign keys get a
  <strong>searchable picker</strong>, so you choose a customer by name instead of typing 4.</p>
  <p>Filters stack, columns sort, and all of it lives in the URL — so any grid you are looking at
  is a link you can send to someone.</p>
</section>

<section id="users">
  <h2><span class="silo">Users</span></h2>
  <p>User administration with <strong>role as the primary lens</strong>, because that is how you
  actually think about users: not "show me everyone", but "who can reach the admin?".</p>
  ${fig('users', 'The Users silo. Role chips filter the list and carry their member counts; a user can hold several roles at once.')}
  <p>Role chips across the top filter the list and show membership counts. Roles are
  many-to-many, so someone can be both an administrator and a member, and the grid shows that
  rather than flattening it to one label. The drawer grants and revokes, and every grant records
  who issued it.</p>
  <div class="note">
    <p><strong>Password hashes and MFA secrets never leave the database.</strong> They are masked
    end to end — not selected, not editable, not filterable, and not sortable either, since
    ordering by a secret leaks its collation order.</p>
  </div>
</section>

<section id="roles">
  <h2><span class="silo">Roles &amp; Permissions</span></h2>
  <p>Roles and their permissions in <em>one</em> editor. There is deliberately no separate policy
  layer to attach to roles — that indirection buys granularity most projects never use, at the
  cost of a second thing to reason about every time.</p>
  ${fig('roles', 'The permission matrix: every table against create, read, update and delete, with row and column bulk toggles and one save for the batch.')}
  <p>Roles carry a rank, where lower is more powerful. Edits stage until you save, so you change
  a dozen cells and commit them together.</p>
  ${fig('roles-superadmin', 'Selecting super_admin shows an explanation rather than an empty grid — it bypasses the permission model entirely, so grants here would be a lie.')}
  <p>Grants for tables that no longer exist surface as a schema-drift block rather than rotting
  silently.</p>
  <div class="warn">
    <p><strong>The matrix stores permissions; nothing enforces them yet.</strong> These rows are
    the definition your application will read once the generated dashboard consumes them. Today
    they govern nothing — worth knowing before you rely on them.</p>
  </div>
</section>

<section id="files">
  <h2><span class="silo">Files</span></h2>
  <p>Uploads, with references treated as a first-class fact.</p>
  ${fig('files', 'The Files silo. Each file shows how many rows reference it and whether its bytes are actually on disk.')}
  <p>Uploading creates the file row <em>immediately</em>, so content can reference it whenever you
  are ready. That kills the two-pass import dance — create the content to get ids, then a second
  pass to attach the images — which is a symptom of a storage layer that demands an owner up
  front.</p>
  <p>Which rows reference a file is discovered from the live foreign-key graph, so a new file
  column is picked up automatically. <strong>Deleting a referenced file is refused</strong>, and
  the refusal names what is holding it.</p>
  <p>Metadata lives in your database and bytes live on disk, which means the two can disagree.
  When they do, the console shows it rather than hiding it.</p>
</section>

<section id="sql">
  <h2><span class="silo">SQL</span></h2>
  <p>A read-only query console for the questions a grid cannot answer.</p>
  ${fig('sql', 'The SQL console. Results are capped, timed, and the query history is kept locally.')}

  <h3>Read-only, three times over</h3>
  <p>The guarantee rests on three independent layers, because the first alone was
  <em>provably</em> insufficient:</p>
  <ol class="layers">
    <li><strong>One statement per run.</strong> Multi-statement input could otherwise lead with
    <code>set transaction read write;</code> and undo the whole thing.</li>
    <li><strong>A read-only transaction</strong> with a 10-second timeout, rolled back
    unconditionally.</li>
    <li><strong>A SELECT-only database role</strong>, when <code>CONSOLE_RO_DATABASE_URL</code> is
    configured — because privileges survive anything a session can change.</li>
  </ol>
  ${fig('sql-readonly', 'A write attempt, refused by Postgres itself rather than by a parser trying to guess what the query meant.')}
  <p>Masked columns are redacted here too, by matching result fields back to their source
  columns — so this lane does not quietly exempt itself from the rule the rest of the console
  follows.</p>
</section>

<section id="builder">
  <h2><span class="silo">Admin Builder</span></h2>
  <p>Where the console builds the other lane. Pick a table, choose the fields, and write an admin
  screen the dashboard renders.</p>
  ${fig('admin-builder', 'The Admin Builder: field editor on the left, live preview on the right. The preview is the real runtime against real data — not a mock.')}

  <h3>It opens on a proposal, not a blank form</h3>
  <p>Choosing a table reads the catalog and drafts a working screen: every non-secret column as a
  field, foreign keys as relations with a <em>guessed</em> display column, and any many-to-many
  detected. You edit a draft rather than filling in a form.</p>
  <p>Join tables are found by a specific rule — <strong>a composite primary key whose columns are
  all foreign keys</strong>. Not "a table with two foreign keys", which misreads a join table
  carrying extra columns like <code>granted_at</code>.</p>

  <h3>The one decision the console cannot make</h3>
  <p>The database stores an opaque id; a person needs to see a name. <em>Which column of the
  other table to display</em> is a judgement call, so it gets its own highlighted control rather
  than hiding among the rest.</p>

  <h3>What gets written</h3>
  <p>Saving writes a <code>.view.json</code> file into your repository — committed and reviewed
  like any other code, not a row in a database that drifts between environments.</p>
  <pre><code>{
  <span class="k">"table"</span>: <span class="s">"orders"</span>,
  <span class="k">"title"</span>: <span class="s">"Customer orders"</span>,
  <span class="k">"fields"</span>: [
    { <span class="k">"kind"</span>: <span class="s">"relation"</span>, <span class="k">"column"</span>: <span class="s">"customer_id"</span>,
      <span class="k">"relation"</span>: { <span class="k">"table"</span>: <span class="s">"customers"</span>, <span class="k">"display"</span>: <span class="s">"email"</span> },
      <span class="k">"label"</span>: <span class="s">"Placed by"</span> }
  ]
}</code></pre>
  <p>The file records <em>decisions only</em>. Anything the runtime would infer — a label matching
  the column name, a widget matching the column type — is stripped before writing, so a
  <code>git diff</code> shows what you actually changed instead of a wall of restated defaults.</p>
  <p>The preview beside it is the genuine runtime: the same components a deployed dashboard
  imports, hitting the same resolver, against real rows. It renders from the file on disk, and
  says so when you have unsaved edits — previewing the draft would let you approve a screen that
  is not what ships.</p>
</section>

<section id="safety">
  <h2>The safety model</h2>
  <p>The console has no authentication in v1. "Local only" <em>is</em> the security model — and it
  is enforced rather than assumed, in three places.</p>
  <table class="ref">
    <thead><tr><th>Layer</th><th>What it stops</th></tr></thead>
    <tbody>
      <tr><td>Binds <code>localhost</code> only</td><td>Anything on your network reaching it. Verified against every local interface.</td></tr>
      <tr><td>Host pinned to loopback</td><td>DNS rebinding, which a loopback bind alone does <em>not</em> prevent.</td></tr>
      <tr><td>Same-origin writes, JSON only</td><td>Drive-by requests from any page you happen to visit. <code>text/plain</code> needs no preflight, so without this a website could have driven <code>drop table</code>.</td></tr>
    </tbody>
  </table>
  <div class="warn">
    <p><strong>Do not expose the console.</strong> It has a full SQL surface and can run DDL. If
    you need it somewhere other than your own machine, it needs real authentication first — not
    another layer on top of these.</p>
  </div>
  <p>Two more rules hold throughout. <strong>Masked columns</strong> — anything that looks like a
  credential — are never selected, editable, filterable or sortable, in every silo including SQL.
  And <strong>identifiers are always verified against the live catalog</strong> and quoted, while
  values are always bound parameters, so a table named
  <code>x; drop table users;--</code> is rejected rather than executed.</p>
</section>

<section id="trouble">
  <h2>Troubleshooting</h2>
  <dl class="trouble">
    <dt><code>127.0.0.1:3180</code> refuses to connect</dt>
    <dd>Expected. Use <code>localhost</code> or <code>[::1]</code>.</dd>

    <dt>Every silo says it cannot reach the database</dt>
    <dd><code>DATABASE_URL</code> in <code>apps/console/.env.local</code> is wrong, or the database
    is not running. The Docker command in getting started uses port <strong>5433</strong>, not
    5432.</dd>

    <dt>Changed a package, the console does not see it</dt>
    <dd>Packages are imported from <code>dist/</code>. Run <code>npm run build</code> in the
    package <em>and restart the console</em> — Next caches the resolved module. If the API keeps
    returning a shape from the previous build, check <code>dist/</code> on disk before
    disbelieving your own code.</dd>

    <dt>Pages 500 with <code>Cannot find module './901.js'</code></dt>
    <dd>Something ran <code>next build</code> while <code>next dev</code> was running and
    overwrote the <code>.next</code> directory underneath it — <code>npm run build</code> at the
    repository root does exactly this. Stop the server, delete <code>apps/console/.next</code>,
    start again.</dd>

    <dt>The first click on each silo is slow</dt>
    <dd>Dev mode compiles a route the first time it is visited. Subsequent visits are fast. For
    using rather than developing the console, <code>npm run console:prod</code> builds and serves
    production.</dd>

    <dt><code>npm audit</code> reports high-severity findings</dt>
    <dd>They are transitive through Next’s build tooling. <strong>Do not run
    <code>npm audit fix --force</code></strong> — it would install <code>next@9.3.3</code>, six
    major versions back. A project installing only the published packages reports zero.</dd>
  </dl>
</section>

<footer class="end">
  <p>Allodium is MIT licensed with no CLA. The software is free forever — that is what the name
  means. Allodial title is land held outright, owing rent to no one.</p>
  <p class="meta">Screenshots generated from the running console against the sample dataset.</p>
</footer>

</main>
</div>`;

const CSS = `
:root {
  --ground: #fcfcfb;
  --raise:  #ffffff;
  --ink:    #1c1c1f;
  --ink-2:  #3f3f46;
  --muted:  #6b6b74;
  --faint:  #9a9aa3;
  --rule:   #e5e5e2;
  --rule-2: #efefec;
  --accent: #047857;
  --accent-soft: #ecfdf5;
  --warn:   #b45309;
  --warn-soft: #fffbeb;
  --warn-rule: #fde68a;
  --code-bg: #f6f6f4;
  --shot-bg: #18181b;
  --sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --ground: #0b0b0d; --raise: #131316; --ink: #e7e7ea; --ink-2: #c4c4cb;
    --muted: #8e8e98; --faint: #64646d; --rule: #26262b; --rule-2: #1c1c20;
    --accent: #34d399; --accent-soft: #0d2620;
    --warn: #fbbf24; --warn-soft: #241c07; --warn-rule: #4d3c10;
    --code-bg: #17171a; --shot-bg: #000;
  }
}
:root[data-theme="dark"] {
  --ground: #0b0b0d; --raise: #131316; --ink: #e7e7ea; --ink-2: #c4c4cb;
  --muted: #8e8e98; --faint: #64646d; --rule: #26262b; --rule-2: #1c1c20;
  --accent: #34d399; --accent-soft: #0d2620;
  --warn: #fbbf24; --warn-soft: #241c07; --warn-rule: #4d3c10;
  --code-bg: #17171a; --shot-bg: #000;
}
:root[data-theme="light"] {
  --ground: #fcfcfb; --raise: #ffffff; --ink: #1c1c1f; --ink-2: #3f3f46;
  --muted: #6b6b74; --faint: #9a9aa3; --rule: #e5e5e2; --rule-2: #efefec;
  --accent: #047857; --accent-soft: #ecfdf5;
  --warn: #b45309; --warn-soft: #fffbeb; --warn-rule: #fde68a;
  --code-bg: #f6f6f4; --shot-bg: #18181b;
}

* { box-sizing: border-box; }
body {
  margin: 0; background: var(--ground); color: var(--ink);
  font-family: var(--sans); font-size: 16px; line-height: 1.65;
  -webkit-font-smoothing: antialiased;
}
.skip {
  position: absolute; left: -9999px; top: 0; background: var(--accent); color: #fff;
  padding: .6rem 1rem; z-index: 50;
}
.skip:focus { left: 0; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 2px; }

.shell { display: grid; grid-template-columns: 232px minmax(0, 1fr); gap: 0; }
/* Grid items default to min-width:auto, which lets long content push a column
   wider than the viewport. Both tracks must be allowed to shrink. */
.shell > * { min-width: 0; }

/* ---------------- rail ---------------- */
.rail {
  position: sticky; top: 0; align-self: start; height: 100vh; overflow-y: auto;
  border-right: 1px solid var(--rule); padding: 1.6rem 0 2rem;
  background: var(--raise);
}
.brand { padding: 0 1.4rem 1.4rem; }
.wordmark { display: block; font-family: var(--mono); font-size: .95rem; font-weight: 700; letter-spacing: -.02em; }
.cursor { color: var(--accent); }
.sub { display: block; font-family: var(--mono); font-size: .62rem; color: var(--faint); letter-spacing: .06em; text-transform: uppercase; margin-top: .3rem; }
.rail nav { display: flex; flex-direction: column; }
.rail a {
  display: flex; align-items: center; gap: .55rem;
  padding: .34rem 1.4rem; color: var(--muted); text-decoration: none;
  font-size: .82rem; border-left: 2px solid transparent;
}
.rail a:hover { color: var(--ink); background: var(--rule-2); }
.dot { width: 4px; height: 4px; border-radius: 50%; background: var(--faint); flex: none; }
.rail a:hover .dot { background: var(--accent); }
.railhead {
  margin: 1.1rem 0 .35rem; padding: 0 1.4rem;
  font-family: var(--mono); font-size: .6rem; letter-spacing: .1em;
  text-transform: uppercase; color: var(--faint);
}

/* ---------------- main ---------------- */
main { padding: 3.2rem 3rem 6rem; max-width: 62rem; }
.masthead { border-bottom: 1px solid var(--rule); padding-bottom: 2rem; margin-bottom: 1rem; }
.eyebrow {
  font-family: var(--mono); font-size: .66rem; letter-spacing: .14em;
  text-transform: uppercase; color: var(--accent); margin: 0 0 .7rem;
}
h1 {
  font-size: clamp(2rem, 4.5vw, 2.9rem); line-height: 1.08; letter-spacing: -.035em;
  margin: 0 0 .9rem; text-wrap: balance; font-weight: 640;
}
.lede { font-size: 1.09rem; color: var(--ink-2); margin: 0 0 1.1rem; max-width: 40rem; }
.lede em { color: var(--ink); font-style: italic; }
.meta { font-family: var(--mono); font-size: .74rem; color: var(--faint); margin: 0; }

section { padding: 2.6rem 0; border-bottom: 1px solid var(--rule-2); }
section:last-of-type { border-bottom: 0; }
h2 {
  font-size: 1.5rem; letter-spacing: -.022em; margin: 0 0 1rem;
  text-wrap: balance; font-weight: 630;
}
h3 {
  font-size: 1.02rem; letter-spacing: -.012em; margin: 2rem 0 .6rem;
  font-weight: 620;
}
.silo {
  font-family: var(--mono); font-size: 1.3rem; font-weight: 600;
}
.silo::before { content: "/"; color: var(--faint); margin-right: .1em; font-weight: 400; }
p { margin: 0 0 .95rem; max-width: 40rem; }
strong { font-weight: 630; color: var(--ink); }
a { color: var(--accent); text-decoration-thickness: 1px; text-underline-offset: 2px; }

code {
  font-family: var(--mono); font-size: .855em; background: var(--code-bg);
  overflow-wrap: anywhere;
  padding: .1em .34em; border-radius: 3px; border: 1px solid var(--rule-2);
}
pre {
  background: var(--code-bg); border: 1px solid var(--rule);
  border-radius: 6px; padding: .95rem 1.1rem; overflow-x: auto; margin: 0 0 1.1rem;
}
pre code { background: none; border: 0; padding: 0; font-size: .82rem; line-height: 1.7; }
pre .c { color: var(--faint); }
pre .k { color: var(--accent); }
pre .s { color: var(--ink-2); }

/* ---------------- figures ---------------- */
figure { margin: 1.5rem 0 1.6rem; }
.shot {
  background: var(--shot-bg); border: 1px solid var(--rule);
  border-radius: 7px; overflow: hidden; line-height: 0;
}
.shot img { width: 100%; height: auto; display: block; }
figcaption {
  font-size: .78rem; color: var(--muted); margin-top: .6rem;
  line-height: 1.5; max-width: 42rem;
}

/* ---------------- callouts ---------------- */
.note, .warn {
  border-radius: 6px; padding: .85rem 1.05rem; margin: 1.2rem 0;
  border: 1px solid var(--rule);
}
.note { background: var(--accent-soft); border-color: color-mix(in srgb, var(--accent) 28%, transparent); }
.warn { background: var(--warn-soft); border-color: var(--warn-rule); }
.warn strong { color: var(--warn); }
.note p, .warn p { margin: 0; font-size: .9rem; max-width: none; }

/* ---------------- tables ---------------- */
.ref { width: 100%; border-collapse: collapse; margin: 1.1rem 0 1.3rem; font-size: .875rem; display: block; overflow-x: auto; }
.ref thead th {
  text-align: left; font-family: var(--mono); font-size: .66rem; letter-spacing: .08em;
  text-transform: uppercase; color: var(--faint); font-weight: 500;
  border-bottom: 1px solid var(--rule); padding: 0 1rem .5rem 0;
}
.ref td { padding: .6rem 1rem .6rem 0; border-bottom: 1px solid var(--rule-2); vertical-align: top; }
.ref td:first-child { white-space: nowrap; font-weight: 590; }

/* ---------------- lists ---------------- */
ol.layers { margin: 0 0 1.1rem; padding-left: 1.2rem; max-width: 40rem; }
ol.layers li { margin-bottom: .5rem; }
ol.layers::marker { color: var(--faint); }

.trouble { margin: 1rem 0 0; }
.trouble dt {
  font-weight: 600; font-size: .92rem; margin-top: 1.3rem;
  padding-top: 1.3rem; border-top: 1px solid var(--rule-2);
}
.trouble dt:first-child { margin-top: 0; padding-top: 0; border-top: 0; }
.trouble dd { margin: .35rem 0 0; color: var(--ink-2); font-size: .92rem; max-width: 40rem; }

.end { margin-top: 3rem; padding-top: 1.6rem; border-top: 1px solid var(--rule); }
.end p { font-size: .85rem; color: var(--muted); max-width: 38rem; }

/* ---------------- responsive ---------------- */
@media (max-width: 900px) {
  .shell { grid-template-columns: 1fr; }
  .rail {
    position: static; height: auto; border-right: 0;
    border-bottom: 1px solid var(--rule); padding: 1.2rem 0;
  }
  .rail nav { flex-flow: row wrap; gap: .1rem .2rem; padding: 0 1rem; }
  .rail a { padding: .28rem .55rem; border-left: 0; border-radius: 4px; }
  .railhead { width: 100%; padding: .6rem 1rem 0; margin: .3rem 0 0; }
  .brand { padding: 0 1rem 1rem; }
  main { padding: 2rem 1.25rem 4rem; }
}
@media (prefers-reduced-motion: reduce) {
  * { animation: none !important; transition: none !important; }
}
`;

writeFileSync(
  process.argv[3],
  `${HEAD}\n<style>${CSS}</style>\n${BODY}\n`
);
console.log('wrote', process.argv[3]);
