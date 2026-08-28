import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ViewDefinition } from '../view.js';

/**
 * Reading `.view.json` files.
 *
 * The console has read these since the Admin Builder existed; a deployed
 * dashboard needs exactly the same thing and should not have to reimplement it —
 * least of all the retry, which exists because of a bug that took a hammer test
 * to find. So the READER graduates into the package. The writer does not: writing
 * definitions is the build lane's job, and it belongs to the console.
 *
 * `ADMIN_VIEWS_DIR` is not read here. Nothing in this package reads env vars; the
 * app passes a directory, and pointing a dashboard at a repo's `admin/views/` is
 * then just a path.
 */

export interface StoredView {
  /** File stem — "posts" for posts.view.json. This is the key in URLs. */
  name: string;
  definition: ViewDefinition;
}

export interface ViewStore {
  /**
   * Null means NO SUCH FILE, and only that. A file that exists but will not parse
   * THROWS with the parser's message: reporting a corrupt file as "unknown view"
   * is a lie about a file sitting right there, and these are hand-editable, so a
   * stray comma is a thing that actually happens.
   */
  load(name: string): Promise<ViewDefinition | null>;
  /** The definition a caller that knows its TABLE should render. See pickViewForTable. */
  loadForTable(name: string, table: string): Promise<ViewDefinition>;
  names(): Promise<string[]>;
  all(): Promise<StoredView[]>;
}

/** The name reaches a filesystem path, so it may not contain anything path-shaped. */
const SAFE_NAME = /^[a-zA-Z0-9_-]+$/;

/**
 * Which definition a caller that knows its TABLE should render.
 *
 * A related panel addresses a table — validated against the catalog — while the
 * view name is only what somebody called a file. Those are two namespaces, one
 * written by the schema and one by hand, and nothing keeps them in step: a file
 * named `post_tags.view.json` containing a view of `tags` satisfied a lookup by
 * name, rendered the wrong table, and failed on the first bound filter. Matching
 * the name was never what made the panel correct.
 *
 * So the table decides and the name only breaks ties: the named file if it really
 * is about this table, else any view that is (preferring one named after it),
 * else the implicit screen. That last step matters as much as the first —
 * "omission means the sensible default" applies here too, so a table with no
 * curated view renders a plain screen rather than erroring.
 */
export function pickViewForTable(
  named: ViewDefinition | null,
  all: StoredView[],
  table: string
): ViewDefinition {
  if (named && named.table === table) return named;
  const preferred = all.find((v) => v.definition.table === table && v.name === table);
  const anyMatch = preferred ?? all.find((v) => v.definition.table === table);
  if (anyMatch) return anyMatch.definition;
  return { table };
}

export function createFileViewStore(opts: {
  dir: string;
  /** Called for a file that could not be parsed while SCANNING. Log it; do not ignore it. */
  onProblem?: (name: string, message: string) => void;
}): ViewStore {
  const dir = opts.dir;
  const fileFor = (name: string) => path.join(dir, `${name}.view.json`);

  const store: ViewStore = {
    async load(name) {
      if (!SAFE_NAME.test(name)) return null;
      const file = fileFor(name);

      /*
       * Re-read a document that will not parse before believing it.
       *
       * `writeFile` is not atomic — it truncates then fills — so a file being
       * rewritten right now reads as truncated. That is a PASSING condition: the
       * writer finishes in milliseconds. Retrying is what makes it invisible, and
       * it covers writers this code does not control (an editor saving, a git
       * checkout) as well as its own. A file that is still broken after the
       * retries is broken for real, and says so.
       */
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
    },

    async names() {
      try {
        const files = await readdir(dir);
        return files
          .filter((f) => f.endsWith('.view.json'))
          .map((f) => f.replace(/\.view\.json$/, ''))
          .sort();
      } catch {
        return []; // no views directory yet is a normal empty state, not an error
      }
    },

    /**
     * Every readable view. Asking for one file by name and SCANNING for a table
     * are different questions, so they answer differently on a broken file.
     *
     * `load('posts')` throws: you asked for that file, and pretending it is
     * absent hides the typo. Scanning does not: a panel for `post_tags` has no
     * business failing because an unrelated `orders.view.json` has a stray comma,
     * and in the console that single typo would break every related panel in the
     * app. Skipped, not swallowed — `onProblem` says what was passed over.
     */
    async all() {
      const out: StoredView[] = [];
      for (const name of await store.names()) {
        try {
          const definition = await store.load(name);
          if (definition) out.push({ name, definition });
        } catch (e) {
          opts.onProblem?.(name, e instanceof Error ? e.message : String(e));
        }
      }
      return out;
    },

    async loadForTable(name, table) {
      const named = await store.load(name);
      // Only read every file when the named one did not already answer it.
      const all = named?.table === table ? [] : await store.all();
      return pickViewForTable(named, all, table);
    },
  };

  return store;
}
