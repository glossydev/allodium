-- Allodium dev seed 009 — the passkeys table @allodium/auth/passkeys' default store needs.
--
-- Run against the container from docs/getting-started.md:
--   docker exec -i allodium-dev-pg psql -U allodium -d allodium_dev -v ON_ERROR_STOP=1 < dev/seed/009-passkeys.sql
--
-- Infrastructure, like 007 and 008. One row per registered authenticator: the
-- credential id the browser reports, the COSE public key (base64url), the
-- signature counter that catches a cloned key, the transports the browser
-- advertised, a label the person gave it, and whether the credential is backed
-- up across devices. There is no secret here — a public key is public — but
-- `credential_id` trips the admin runtime's masking (it contains "credential"),
-- which is harmless.
--
-- Idempotent: safe to re-run, safe on a database that already has the table.

create table if not exists passkeys (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users(id) on delete cascade,
  credential_id varchar(1024) not null unique,
  public_key    text not null,
  counter       bigint not null default 0,
  transports    text[] not null default '{}',
  label         varchar(120),
  backed_up     boolean not null default false,
  device_type   varchar(16),
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz
);

create index if not exists passkeys_user_id_idx on passkeys (user_id);

comment on table passkeys is 'WebAuthn credentials. The public key is public; the authenticator holds the private half.';
comment on column passkeys.counter is 'Signature counter from the authenticator. A sign-in that does not advance it is refused: a cloned key.';

insert into role_permissions (role_id, table_name, can_create, can_read, can_update, can_delete)
select r.id, 'passkeys', false, true, false, true from roles r where r.key = 'admin'
on conflict (role_id, table_name) do nothing;
