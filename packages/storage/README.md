# @allodium/storage

A three-method byte store, and the headers that stop an upload from becoming an XSS.

```bash
npm install @allodium/storage
```

Requires Node 20+. No peer dependencies — this one is self-contained.

## The driver

```ts
import { createLocalDiskDriver } from '@allodium/storage';

export const storage = createLocalDiskDriver({
  root: () => process.env.UPLOADS_DIR!,   // thunk: read at call time
});

await storage.put('a1b2c3.png', buffer);
const file = await storage.stream('a1b2c3.png');   // { stream, size } | null
await storage.delete('a1b2c3.png');                // idempotent
```

Three methods. An S3-compatible driver slots into the same interface later without
touching your application code.

## Bytes only — metadata belongs in your database

The driver stores **bytes keyed by a disk name you generate**. It does not store the
original filename, the MIME type, the uploader, or timestamps.

That is deliberate and it is the most important decision in the package. Metadata in
sidecar files means:

- no foreign keys — nothing can reference a file, so nothing can prevent deleting one
  that is still in use
- no queries — "every file over 10MB uploaded last month" needs a directory walk
- two sources of truth that drift

Put a `files` table in your database, and the disk name in a column. Then a file is just
a row, and every tool you already have works on it. An early version of this package did
sidecar JSON; it was removed, and reintroducing it would be a regression.

**Local disk on one box is a first-class production choice**, not a dev-mode fallback.
The layout is flat `{uuid}.{ext}`, which is what Directus's local driver used — so a
copied uploads volume serves unchanged after a migration.

## Serving files safely

```ts
import { assetContentHeaders, diskExtension } from '@allodium/storage';

const headers = assetContentHeaders({
  type: file.mime_type,
  size: found.size,
  downloadName: file.filename,
  forceDownload: url.searchParams.has('download'),
  isProtected: true,           // auth-gated → private, no-cache
});
return new Response(stream, { headers });
```

What this gets right, all of which are easy to get wrong by hand:

**SVG is never served inline.** An SVG is a document that can carry script, so serving a
user-uploaded one inline is stored XSS with extra steps. `INLINE_SAFE_TYPES` excludes it
deliberately — SVGs download instead. This is the single most common file-upload
vulnerability and it is one line to avoid.

**`X-Content-Type-Options: nosniff`** on everything, so a browser cannot decide your
`text/plain` is really HTML.

**RFC 5987 filenames.** `Content-Disposition` with both an ASCII fallback and a UTF-8
encoding, so a file called `résumé.pdf` downloads with its name intact instead of
`r_sum_.pdf` or a broken header.

**Cache split by protection.** Public assets get a long cache; auth-gated ones get
`private, no-cache`, so a shared proxy cannot hand one user's document to another.

`diskExtension(mimeType, originalName)` derives a safe extension for the disk name,
preferring the declared MIME type over a filename anyone can control.

## Uploads happen first

Because a file row exists the moment the bytes land, content can reference it whenever.
The two-pass import dance — create the content to get ids, then a second pass to attach
images — is a symptom of a storage layer that requires an owner up front. This one
doesn't.

## License

MIT. No CLA.
