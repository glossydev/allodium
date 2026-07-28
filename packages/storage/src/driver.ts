import { createReadStream } from 'node:fs';
import { mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';

/**
 * The storage seam: application code never touches a filesystem or an object-store SDK
 * directly — it talks to a StorageDriver keyed by an app-generated disk name.
 *
 * Deliberate design (from the reference deployment's CMS exit):
 * - The driver stores BYTES ONLY. File metadata (original name, MIME type, owner,
 *   timestamps) belongs in your database's files table, where foreign keys can reach
 *   it — not in sidecar files a driver owns.
 * - Flat layout under one root, `{uuid}.{ext}` names — exactly what Directus's local
 *   driver used, so a copied uploads volume serves unchanged after a migration.
 * - "Local disk on one box" is a first-class production choice, not a dev-mode hack;
 *   an S3-compatible driver slots into the same three methods later.
 */

export interface StorageDriver {
  put(filenameDisk: string, data: Buffer): Promise<void>;
  stream(filenameDisk: string): Promise<{ stream: Readable; size: number } | null>;
  /** Idempotent — deleting a missing file is a no-op. */
  delete(filenameDisk: string): Promise<void>;
}

/** Reject anything that could escape the root — disk names are app-generated uuids. */
const safeName = (name: string): string | null => {
  if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) return null;
  return name;
};

/**
 * Local-disk driver. `root` may be a thunk (e.g. `() => process.env.UPLOADS_DIR`) so
 * env-driven config keeps call-time semantics. The root must live OUTSIDE your git tree
 * in production and INSIDE your backup set.
 */
export function createLocalDiskDriver(opts: { root: string | (() => string) }): StorageDriver {
  const root = typeof opts.root === 'function' ? opts.root : () => opts.root as string;

  return {
    async put(filenameDisk, data) {
      const name = safeName(filenameDisk);
      if (!name) throw new Error('Invalid storage filename');
      const dir = root();
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, name), data);
    },

    async stream(filenameDisk) {
      const name = safeName(filenameDisk);
      if (!name) return null;
      const full = path.join(root(), name);
      try {
        const s = await stat(full);
        if (!s.isFile()) return null;
        return { stream: createReadStream(full), size: s.size };
      } catch {
        return null;
      }
    },

    async delete(filenameDisk) {
      const name = safeName(filenameDisk);
      if (!name) return;
      try {
        await unlink(path.join(root(), name));
      } catch {
        /* already gone — deletion is idempotent */
      }
    },
  };
}
