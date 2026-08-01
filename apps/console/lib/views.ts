import 'server-only';
import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
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

export async function loadView(name: string): Promise<ViewDefinition | null> {
  if (!SAFE_NAME.test(name)) return null; // the name reaches a filesystem path
  try {
    const raw = await readFile(path.join(VIEWS_DIR(), `${name}.view.json`), 'utf8');
    return JSON.parse(raw) as ViewDefinition;
  } catch {
    return null;
  }
}

/**
 * Write a definition to disk. The console is a build-time tool with filesystem
 * access, so authoring produces a file you commit — not a row someone has to
 * migrate between environments.
 */
export async function saveView(name: string, definition: ViewDefinition): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  if (!SAFE_NAME.test(name)) return { ok: false, error: 'Name may contain letters, numbers, hyphens and underscores only' };
  const dir = VIEWS_DIR();
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${name}.view.json`);
  // Trailing newline so the file is a well-behaved citizen of a git diff.
  await writeFile(file, JSON.stringify(definition, null, 2) + '\n', 'utf8');
  return { ok: true, path: file };
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
    const definition = await loadView(name);
    if (definition) out.push({ name, definition });
  }
  return out;
}
