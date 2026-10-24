-- Allodium dev seed 008 — the api_tokens table @allodium/auth's createApiTokens needs.
--
-- Run against the container from docs/getting-started.md:
--   docker exec -i allodium-dev-pg psql -U allodium -d allodium_dev -v ON_ERROR_STOP=1 < dev/seed/008-api-tokens.sql
--
-- Infrastructure, like 007. A machine caller — a job runner, another service, an
-- agent's MCP, a deploy script — has no cookie jar, and the usual answer is one
-- shared secret in an environment variable that nobody can rotate, scope, revoke
-- or attribute. This table is the alternative: one row per token, the secret
-- stored only as a SHA-256 digest, a label saying what holds it, an optional
-- user it acts as (or roles of its own for a service token), an expiry, a
-- revocation, and when it was last seen.
--
-- `token_hash` trips the admin runtime's masking (it ends in _hash), so the digest
-- is never selected, returned, filtered or sorted by a screen. The admin role gets
-- the table so tokens can be managed from a back office; nothing else does.
--
-- Idempotent: safe to re-run, safe on a database that already has the table.

create table if not exists api_tokens (
  id           uuid primary key default gen_random_uuid(),
  label        varchar(120) not null,
  token_hash   char(64) not null unique,
  user_id      uuid references users(id) on delete cascade,
  roles        text[] not null default '{}',
  created_at   timestamptz not null default now(),
  expires_at   timestamptz,
  last_used_at timestamptz,
  revoked_at   timestamptz
);

create index if not exists api_tokens_user_id_idx on api_tokens (user_id);

comment on table api_tokens is 'Bearer tokens for machine callers. The secret is stored only as a digest and shown once, at minting.';
comment on column api_tokens.user_id is 'The user this token acts as. Null for a service token, which acts as its roles alone and owns no rows.';
comment on column api_tokens.roles is 'Role keys the token carries. Empty means the user''s own roles.';

insert into role_permissions (role_id, table_name, can_create, can_read, can_update, can_delete)
select r.id, 'api_tokens', true, true, true, true from roles r where r.key = 'admin'
on conflict (role_id, table_name) do nothing;
