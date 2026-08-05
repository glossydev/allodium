-- Allodium dev seed 005 — real argon2id password hashes.
--
-- Seeds 002 gave every user the same hand-written placeholder digest
-- ($argon2id$...$0000000000...). It is not a real hash: argon2.verify rejects it, so
-- NOBODY COULD LOG IN. That was harmless while the console was the only consumer (the
-- console lane has no login — it is loopback-pinned and runs unauthenticated), but the
-- end-to-end harness cannot start without a working credential.
--
-- Every digest below was produced by @allodium/auth's own hashPassword() — the same
-- function the login path calls — and round-tripped through verifyPassword() before
-- being written here, including a negative check against a wrong password. Distinct
-- salts throughout: one shared constant would let a broken comparison pass.
--
--   PASSWORD FOR EVERY SEEDED USER:  devpassword
--
-- This database is a local toy on port 5433 and password_hash is masked in the console.
-- Do not carry this file, or that password, anywhere near a deployed database.
--
-- Applied as an UPDATE rather than a rewrite of 002 so an already-running dev database
-- can be fixed in place without a full reseed.
--
-- Apply:  docker exec -i allodium-dev-pg psql -U allodium -d allodium_dev \
--           -v ON_ERROR_STOP=1 < dev/seed/005-real-password-hashes.sql

\set ON_ERROR_STOP on
BEGIN;

-- ---------------------------------------------------------------------------
-- Named staff — one distinct digest each.
--
-- Their roles and statuses (set in 002) are what make this fixture useful, so they
-- are restated here as the map the harness tests against:
--
--   adam@glossydev.com     super_admin + admin   active      <- multi-role: the gate
--                                                               must UNION grants, and
--                                                               super_admin's bypass
--                                                               must be explicit (it
--                                                               holds zero grant rows)
--   dana@example.com       admin                 active
--   marco@example.com      support               active      <- read-only on products
--   priya@example.com      marketing             active
--   ada@example.com        marketing             active
--   alan@example.com       marketing             active
--   sam.locke@example.com  support               SUSPENDED   <- correct password, must
--   newhire@example.com    support               INVITED        still fail, and fail
--                                                               distinguishably from a
--                                                               wrong password
-- ---------------------------------------------------------------------------

UPDATE users SET password_hash = '$argon2id$v=19$m=65536,t=3,p=4$d59KiY8ogsJ6DOvgsO1CDQ$RrJkJEkpcnKRdRGmSKt4xDtgkTQ0qLoG3aDr0MTsgMc' WHERE email = 'adam@glossydev.com';
UPDATE users SET password_hash = '$argon2id$v=19$m=65536,t=3,p=4$QD44166GPwvWHB1/JJJChA$I9pgbAh+Q5YQ9EOMHP0TFtit4xOou1p2J6Jsl4w0Phg' WHERE email = 'dana@example.com';
UPDATE users SET password_hash = '$argon2id$v=19$m=65536,t=3,p=4$3iRsuShQ0/E2rlG9K7gveA$UY1Q2TURTK2Jz1+zy8FQ2RSykmwh7xX6qqJ05VV7tlk' WHERE email = 'marco@example.com';
UPDATE users SET password_hash = '$argon2id$v=19$m=65536,t=3,p=4$OJOY6tLyibPRAN9sQKtQTA$vXalEx1duOlrslvNe9PGOprioRhEu3BmVpIB5nkrtl8' WHERE email = 'priya@example.com';
UPDATE users SET password_hash = '$argon2id$v=19$m=65536,t=3,p=4$DR4TcVaR9SgvaAk9nGlQ+g$5YbpmOdL2rmevoS66WwbGCHA3CWRs+gcr/Kx3CvRDS0' WHERE email = 'sam.locke@example.com';
UPDATE users SET password_hash = '$argon2id$v=19$m=65536,t=3,p=4$BKhJgj1Clm1nOfK/78FmRg$A4jilfH5MfvEKamWGt7pjcoFdUQcclrwTS3NqqOkimQ' WHERE email = 'newhire@example.com';
UPDATE users SET password_hash = '$argon2id$v=19$m=65536,t=3,p=4$EfE9btwVa5Qnf4GoeslvEA$qj/8NjKAgi0jUBkWa3RfAdsF8SEvCVij0hgbc0NcIrQ' WHERE email = 'ada@example.com';
UPDATE users SET password_hash = '$argon2id$v=19$m=65536,t=3,p=4$BVcIyirw3F5reFyg1bpEjQ$o72UQOiJBhvgxCUVzgtSkGf+cRhIvF3D6Q5jL1sRAFU' WHERE email = 'alan@example.com';

-- ---------------------------------------------------------------------------
-- The 40 generated members — one shared digest.
--
-- Bulk fixture, not individuals: they exist for pagination and for the zero-grant case
-- (the member role holds no role_permissions rows at all, and that empty set is
-- meaningful — it must read as "no admin surface", never as an error). Their varied
-- statuses from 002 are preserved: i%17=0 deactivated, i%13=0 invited, rest active.
-- ---------------------------------------------------------------------------

UPDATE users
SET password_hash = '$argon2id$v=19$m=65536,t=3,p=4$fOdrmjb4EeZFXg8sRzR4CQ$B2/Sl2J8c6u4wTaUHsNpVcixqvgmQLJY1lWy0/GKKzs'
WHERE email LIKE 'member%@example.com';

-- ---------------------------------------------------------------------------
-- Guard: no placeholder digest may survive.
--
-- The failure this catches is a silent one — a user added to 002 later, or an edit that
-- misses a row, leaves an account that can never authenticate and produces a login bug
-- that looks like anything but bad seed data. Fail at seed time instead.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  stragglers text;
BEGIN
  SELECT string_agg(email, ', ' ORDER BY email) INTO stragglers
  FROM users
  WHERE password_hash LIKE '%$0000000000%' OR password_hash NOT LIKE '$argon2id$%';

  IF stragglers IS NOT NULL THEN
    RAISE EXCEPTION 'Users still hold a placeholder or non-argon2id password_hash: %', stragglers;
  END IF;
END $$;

COMMIT;
