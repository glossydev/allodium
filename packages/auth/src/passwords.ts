import argon2 from 'argon2';

/**
 * Password hashing: argon2id via node-argon2's defaults (m=65536, t=3, p=4).
 *
 * These parameters are deliberately the same ones Directus uses, in both directions:
 * hashes produced by a Directus deployment verify here unchanged (parameters are read
 * from the hash string), and hashes created here verify in Directus during a parallel
 * run — so a migration needs zero password resets. Audited in production during the
 * reference deployment's cutover: 21/21 users verified.
 */

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password);
}

/** False on mismatch, malformed hash, or null hash — never throws on the login path. */
export async function verifyPassword(hash: string | null | undefined, password: string): Promise<boolean> {
  if (!hash || !hash.startsWith('$argon2')) return false;
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

/**
 * A real argon2id hash of a random throwaway string, for timing equalization: when the
 * looked-up user doesn't exist (or is ineligible), verify the submitted password against
 * this instead of skipping the verify, so response timing can't distinguish "no such
 * account" from "wrong password".
 */
export const DUMMY_ARGON2ID_HASH =
  '$argon2id$v=19$m=65536,p=4,t=3$r5/l4lj1fHcz+2n6zW5Hqw$Mbkf6TySpCkDsNHd4UqC6jloSlRnLBgnJT82XC/ChHA';
