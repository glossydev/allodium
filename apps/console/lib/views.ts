import 'server-only';
import { readdir, readFile } from 'node:fs/promises';
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

export async function loadAllViews(): Promise<StoredView[]> {
  const names = await listViewNames();
  const out: StoredView[] = [];
  for (const name of names) {
    const definition = await loadView(name);
    if (definition) out.push({ name, definition });
  }
  return out;
}
