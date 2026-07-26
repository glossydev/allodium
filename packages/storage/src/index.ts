/**
 * @allodium/storage — the storage seam.
 *
 * Design rule: application code never touches a filesystem or an S3 SDK directly; it talks
 * to a StorageDriver. That keeps AGPL/vendor object stores strictly at arm's length (a
 * deployed service you can swap, never a linked dependency) and makes "local disk on one
 * box" a first-class production choice rather than a dev-mode hack.
 */

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, sep } from 'node:path';
import type { Readable } from 'node:stream';

export interface StoredFile {
  /** Opaque stable id (uuid). This is what you store in your database columns. */
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  /** Hex sha256 of the content — dedupe/integrity checks. */
  sha256: string;
  storedAt: Date;
}

export interface PutOptions {
  /** Client-supplied filename (sanitized before storage; never trusted for paths). */
  filename: string;
  mimeType: string;
  /** Optionally force the id (used by migration importers to preserve existing FKs). */
  id?: string;
}

export interface StorageDriver {
  put(content: Buffer | Uint8Array, opts: PutOptions): Promise<StoredFile>;
  /** Returns a readable stream + metadata, or null when the id is unknown. */
  get(id: string): Promise<{ stream: Readable; file: StoredFile } | null>;
  delete(id: string): Promise<boolean>;
  exists(id: string): Promise<boolean>;
}

/** Strip path separators and control characters from client filenames. */
export function sanitizeFilename(name: string): string {
  const cleaned = name
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .split(/[\\/]/)
    .pop()!
    .trim();
  return cleaned.length > 0 ? cleaned.slice(0, 200) : 'file';
}

/**
 * Local-disk driver. Layout: <root>/<id[0..1]>/<id> for the bytes and a sibling
 * <id>.json metadata record. Two-level fan-out keeps directories small at any scale a
 * single box will ever see.
 */
export class LocalDiskDriver implements StorageDriver {
  constructor(private readonly root: string) {}

  private pathFor(id: string): string {
    // ids are uuids we generate; still, never let one traverse.
    const safe = normalize(id).replace(/[\\/.]/g, '');
    return join(this.root, safe.slice(0, 2), safe);
  }

  async put(content: Buffer | Uint8Array, opts: PutOptions): Promise<StoredFile> {
    const id = opts.id ?? randomUUID();
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const file: StoredFile = {
      id,
      filename: sanitizeFilename(opts.filename),
      mimeType: opts.mimeType,
      size: buf.byteLength,
      sha256: createHash('sha256').update(buf).digest('hex'),
      storedAt: new Date(),
    };
    const path = this.pathFor(id);
    await mkdir(dirname(path), { recursive: true });
    // Write-then-rename for atomicity on the same filesystem.
    const tmp = `${path}.tmp-${randomUUID()}`;
    await writeFile(tmp, buf);
    await rename(tmp, path);
    await writeFile(`${path}.json`, JSON.stringify({ ...file, storedAt: file.storedAt.toISOString() }));
    return file;
  }

  async get(id: string): Promise<{ stream: Readable; file: StoredFile } | null> {
    const path = this.pathFor(id);
    try {
      const metaRaw = await readFile(`${path}.json`, 'utf8');
      const meta = JSON.parse(metaRaw);
      await stat(path);
      return {
        stream: createReadStream(path),
        file: { ...meta, storedAt: new Date(meta.storedAt) },
      };
    } catch {
      return null;
    }
  }

  async delete(id: string): Promise<boolean> {
    const path = this.pathFor(id);
    try {
      await rm(path);
      await rm(`${path}.json`, { force: true });
      return true;
    } catch {
      return false;
    }
  }

  async exists(id: string): Promise<boolean> {
    try {
      await stat(this.pathFor(id));
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Response headers for serving user-uploaded content safely from your app origin.
 * `attachment` disposition + nosniff neutralizes stored-XSS via SVG/HTML uploads;
 * pass inline=true only for types you explicitly trust to render (e.g. raster images).
 */
export function assetHeaders(file: StoredFile, opts?: { inline?: boolean; maxAgeSeconds?: number }): Record<string, string> {
  const inline = opts?.inline ?? false;
  const maxAge = opts?.maxAgeSeconds ?? 31536000;
  return {
    'Content-Type': file.mimeType,
    'Content-Length': String(file.size),
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${file.filename.replace(/"/g, '')}"`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': `private, max-age=${maxAge}`,
    ETag: `"${file.sha256}"`,
  };
}

/** Raster image types safe to render inline. SVG is deliberately excluded. */
export const INLINE_SAFE_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
]);

export { sep as pathSeparator };
