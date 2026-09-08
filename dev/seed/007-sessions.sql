-- Allodium dev seed 007 — the sessions table @allodium/auth needs.
--
-- Run against the container from docs/getting-started.md:
--   docker exec -i allodium-dev-pg psql -U allodium -d allodium_dev -v ON_ERROR_STOP=1 < dev/seed/007-sessions.sql
--
-- Every seed before this one describes the DEMO: a blog, a shop, the people who
-- run them. This one is infrastructure. createSessionStore() keeps its sessions
-- here — one row per signed-in surface, the access and refresh tokens stored as
-- SHA-256 digests, never the tokens — and until now the table existed only where
-- somebody had made it by hand. A database seeded 001→006 could not sign anyone
-- in, which is a bad way to discover a missing seed on a fresh machine.
--
-- The shape is exactly what @allodium/auth's session store and its integration
-- battery declare (packages/auth/test/integration.mjs). `origin` is the surface
-- a session was minted for — "site", "admin" — and is what stops a cookie moved
-- between surfaces from resolving.
--
-- Idempotent: safe to re-run, safe on a database that already has the table.

create table if not exists sessions (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references users(id) on delete cascade,
  access_hash        char(64) not null,
  refresh_hash       char(64) not null,
  access_expires_at  timestamptz not null,
  refresh_expires_at timestamptz not null,
  last_used_at       timestamptz default now(),
  ip                 varchar(64),
  user_agent         varchar(255),
  origin             varchar(16) not null default 'password'
);

comment on table sessions is
  'Signed-in sessions, one per surface. Tokens are stored as SHA-256 digests only; origin is the surface the session belongs to.';

create index if not exists sessions_access_hash_idx  on sessions (access_hash);
create index if not exists sessions_refresh_hash_idx on sessions (refresh_hash);
create index if not exists sessions_user_id_idx      on sessions (user_id);

-- The console's read-only SQL role (seed 004) should see this table like every
-- other — but that role is optional and console-only, so grant it only where it
-- exists rather than fail the seed on a database that never created it.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'allodium_ro') then
    grant select on sessions to allodium_ro;
  end if;
end $$;
