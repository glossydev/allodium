/**
 * Serving user-uploaded content safely from your own origin.
 *
 * STORED-XSS GUARD: `nosniff` on every response, and only raster images + pdf serve
 * inline — svg/html/unknown types always download as attachments. An uploaded SVG that
 * renders inline on your origin is a script injection; this policy is why the set below
 * deliberately excludes it.
 */

/** Types safe to render inline. SVG is deliberately excluded (stored-XSS guard). */
export const INLINE_SAFE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'application/pdf',
]);

const EXT_BY_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'application/pdf': 'pdf',
};

/**
 * Derive the on-disk extension for an upload from its MIME type, falling back to the
 * client filename's extension when the type is unmapped. Only simple alphanumeric
 * extensions survive; anything odd stores as 'bin' (the DB row's type +
 * filename_download still carry the truth).
 */
export function diskExtension(mimeType: string | null | undefined, originalName: string | null | undefined): string {
  const byType = mimeType ? EXT_BY_TYPE[mimeType] : undefined;
  if (byType) return byType;
  const name = originalName ?? '';
  const dot = name.lastIndexOf('.');
  const fromName = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  return /^[a-z0-9]{1,8}$/.test(fromName) ? fromName : 'bin';
}

/**
 * Response headers for streaming a stored file: Content-Type/Length, nosniff,
 * RFC 5987 Content-Disposition (UTF-8 filename* with a plain-ASCII fallback), and the
 * cache split — protected files `private, no-cache`, public files immutable-forever
 * (ids are uuids; a changed file is a new id).
 */
export function assetContentHeaders(opts: {
  /** Stored MIME type; null falls back to application/octet-stream. */
  type: string | null | undefined;
  size: number;
  /** The user-facing filename (your filename_download, falling back to the disk name). */
  downloadName: string;
  /** True when ?download was requested — forces attachment even for inline-safe types. */
  forceDownload?: boolean;
  /** True when the file is auth-gated — switches cache policy to private, no-cache. */
  isProtected?: boolean;
  /** Override the inline-safe set (default INLINE_SAFE_TYPES). */
  inlineTypes?: Set<string>;
}): Record<string, string> {
  const type = opts.type || 'application/octet-stream';
  const inlineTypes = opts.inlineTypes ?? INLINE_SAFE_TYPES;
  const inline = !opts.forceDownload && inlineTypes.has(type);
  const fallbackName = opts.downloadName.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, "'");
  const encodedName = encodeURIComponent(opts.downloadName);

  return {
    'Content-Type': type,
    'Content-Length': String(opts.size),
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${fallbackName}"; filename*=UTF-8''${encodedName}`,
    'Cache-Control': opts.isProtected ? 'private, no-cache' : 'public, max-age=31536000, immutable',
  };
}
