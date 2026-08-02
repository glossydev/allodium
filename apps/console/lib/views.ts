import 'server-only';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ViewDefinition } from '@allodium/admin/view';

/**
 * View definitions live as JSON files in the repo — committed, diffable, reviewed
 * in PRs like any other code. The console (a build-time, local tool with filesystem
 * access) writes them; the dashboard reads them at runtime.
 *
 * Deliberately NOT rows in a database: config-in-the-database is what makes it
 * impossible to diff an admin change, review it, or explain why staging and
 * production differ. "Schema changes are code" applies to screens too.
 */

const VIEWS_DIR = () => process.env.ADMIN_VIEWS_DIR || path.join(process.cwd(), 'admin', 'views');

const SAFE_NAME = /^[a-zA-Z0-9_-]+$/;

/* ------------------------------ $schema ------------------------------ */

/**
 * The pointer written at the top of every saved file, so hand-editing one in an
 * editor gets completion, enum values and inline documentation.
 *
 * A RELATIVE path to the installed package is preferred over a URL: it needs no
 * network, and it pins the file to the version of the runtime actually installed
 * — a definition should be checked against the schema that will render it, not
 * against whatever is newest.
 */
const SCHEMA_URL = 'https://unpkg.com/@allodium/admin/view.schema.json';

const schemaRefCache = new Map<string, string>();

export function schemaRef(): string {
  const dir = path.resolve(VIEWS_DIR());
  const cached = schemaRefCache.get(dir);
  if (cached) return cached;

  // Walk up exactly the way a resolver would. In this monorepo that lands on the
  // workspace junction at the repo root; in a consuming app, on its node_modules.
  let at = dir;
  for (;;) {
    const candidate = path.join(at, 'node_modules', '@allodium', 'admin', 'view.schema.json');
    if (existsSync(candidate)) {
      // POSIX separators: a JSON pointer is a URI reference, not a Windows path.
      const ref = path.relative(dir, candidate).split(path.sep).join('/');
      schemaRefCache.set(dir, ref);
      return ref;
    }
    const parent = path.dirname(at);
    if (parent === at) break;
    at = parent;
  }

  // Not installed where we can see it — fall back to the published copy rather
  // than write a relative path that resolves to nothing and paints the whole file
  // red in an editor. Nearly unreachable in practice: the console imports
  // @allodium/admin to run at all, so if that resolves, so does this. (The URL
  // starts serving with the first release that ships view.schema.json.)
  schemaRefCache.set(dir, SCHEMA_URL);
  return SCHEMA_URL;
}

export interface StoredView {
  /** File stem — "posts" for posts.view.json. This is the key in URLs. */
  name: string;
  definition: ViewDefinition;
}

export async function listViewNames(): Promise<string[]> {
  try {
    const files = await readdir(VIEWS_DIR());
    return files.filter((f) => f.endsWith('.view.json')).map((f) => f.replace(/\.view\.json$/, '')).sort();
  } catch {
    return []; // no views directory yet is a normal empty state, not an error
  }
}

/**
 * Null means NO SUCH FILE. A file that exists but will not parse throws instead,
 * because "unknown view" is a lie about a file sitting right there — and these
 * are hand-editable, so a stray comma is a thing that actually happens. The
 * caller turns the throw into the parser's own message, same contract as the
 * DDL preview: the actionable part of an error is the part worth keeping.
 */
export async function loadView(name: string): Promise<ViewDefinition | null> {
  if (!SAFE_NAME.test(name)) return null; // the name reaches a filesystem path
  const file = path.join(VIEWS_DIR(), `${name}.view.json`);

  // Re-read a document that will not parse before believing it.
  //
  // A file being rewritten right now reads as truncated, and that is a passing
  // condition — the writer finishes in milliseconds. Retrying here is what makes
  // it invisible, and it covers writers this code does not control (an editor
  // saving the file, a git checkout) as well as its own. A file that is STILL
  // broken after the retries is broken for real, and says so.
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch {
      return null; // genuinely absent
    }
    try {
      return JSON.parse(raw) as ViewDefinition;
    } catch (e) {
      lastError = e;
      await new Promise((r) => setTimeout(r, 15 * (attempt + 1)));
    }
  }
  throw new Error(`${name}.view.json is not valid JSON: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

/**
 * Write a definition to disk. The console is a build-time tool with filesystem
 * access, so authoring produces a file you commit — not a row someone has to
 * migrate between environments.
 */
export async function saveView(
  name: string,
  definition: ViewDefinition
): Promise<{ ok: true; path: string; definition: ViewDefinition } | { ok: false; error: string }> {
  if (!SAFE_NAME.test(name)) return { ok: false, error: 'Name may contain letters, numbers, hyphens and underscores only' };
  const dir = VIEWS_DIR();
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${name}.view.json`);

  // $schema first, and re-derived rather than carried through from the loaded file,
  // so moving a repo or upgrading the package heals the pointer on the next save.
  const { $schema: _stale, ...rest } = definition;
  const written: ViewDefinition = { $schema: schemaRef(), ...rest };

  // Write-then-rename, NOT writeFile.
  //
  // writeFile truncates and then fills, so anything reading the same path mid-write
  // sees a partial document. That is not theoretical — hammering a reader against a
  // writer on this file tore 28 of 253 reads. The live preview refetches on save,
  // and a deployed dashboard reads these files continuously, so a plain write turns
  // every save into a chance of "view not found" somewhere else.
  //
  // rename over an existing path is atomic within a filesystem, so a reader sees
  // either the whole old file or the whole new one. The temp file must therefore sit
  // in the same directory, and carries the pid so two saves cannot collide on it.
  // Trailing newline so the file is a well-behaved citizen of a git diff.
  const body = JSON.stringify(written, null, 2) + '\n';
  const tmp = path.join(dir, `.${name}.${process.pid}.${tmpSeq++}.tmp`);
  try {
    await writeFile(tmp, body, 'utf8');
    await replaceAtomically(tmp, file);
  } catch {
    // Could not swap it in. Write straight to the target rather than lose the
    // save — a reader may briefly see a partial file, which is exactly what
    // loadView's re-read handles.
    await unlink(tmp).catch(() => {});
    await writeFile(file, body, 'utf8');
  }
  return { ok: true, path: file, definition: written };
}

let tmpSeq = 0;

/**
 * rename() onto an existing path, retrying the Windows sharing violation.
 *
 * On Windows a rename fails EPERM while ANY process holds the destination open,
 * and Node's readFile does hold it — briefly, but a preview refetch or a deployed
 * dashboard reads these files constantly. Short backoffs clear ordinary
 * contention; under a reader that never lets go they will not, which is why the
 * caller falls back to a plain write instead of failing the save. On POSIX the
 * first attempt always wins and none of this runs.
 */
async function replaceAtomically(from: string, to: string): Promise<void> {
  const CONTENDED = new Set(['EPERM', 'EBUSY', 'EACCES']);
  for (let attempt = 0; ; attempt++) {
    try {
      return await rename(from, to);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? '';
      if (attempt >= 5 || !CONTENDED.has(code)) throw e;
      await new Promise((r) => setTimeout(r, 10 * (attempt + 1)));
    }
  }
}

export async function deleteView(name: string): Promise<boolean> {
  if (!SAFE_NAME.test(name)) return false;
  try {
    await unlink(path.join(VIEWS_DIR(), `${name}.view.json`));
    return true;
  } catch {
    return false;
  }
}

export async function loadAllViews(): Promise<StoredView[]> {
  const names = await listViewNames();
  const out: StoredView[] = [];
  for (const name of names) {
    try {
      const definition = await loadView(name);
      if (definition) out.push({ name, definition });
    } catch (e) {
      // One unparseable file must not blank the whole index — but it should not
      // vanish quietly either, or the picker just silently lacks an entry.
      console.warn(`[console] skipping ${name}.view.json — ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return out;
}
