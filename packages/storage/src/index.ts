/**
 * @allodium/storage — the storage seam.
 *
 * A three-method byte-store driver (put/stream/delete by app-generated disk name) with
 * a production local-disk implementation, plus the safe-serving helpers: the
 * inline-safe type set, disk-extension derivation, and asset response headers with the
 * nosniff + attachment-for-svg stored-XSS guard and the protected/public cache split.
 *
 * Metadata lives in YOUR files table (where foreign keys can reach it); access policy
 * lives in YOUR serving route. This package owns bytes and headers — the two halves
 * every deployment shares.
 */

export { createLocalDiskDriver, type StorageDriver } from './driver.js';
export { INLINE_SAFE_TYPES, diskExtension, assetContentHeaders } from './serving.js';
