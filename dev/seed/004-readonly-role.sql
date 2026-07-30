-- Allodium dev seed 004 — least-privilege role for the SQL silo.
--
-- WHY: the SQL console's read-only guarantee must not depend on session state the
-- query itself can change. `set transaction read only` and `set local
-- statement_timeout` are overridable by a multi-statement query (that was a real,
-- verified bypass — see apps/console/lib/sql-guard.ts). PRIVILEGES are not
-- overridable from inside the session, so the durable fix is a role that simply
-- cannot write.
--
-- The console still layers the statement guard + read-only transaction on top; this
-- is the floor beneath them.
--
-- Apply:  docker exec -i allodium-dev-pg psql -U chapterhub_user -d allodium_dev \
--           -v ON_ERROR_STOP=1 < dev/seed/004-readonly-role.sql
--
-- Then set in apps/console/.env.local:
--   CONSOLE_RO_DATABASE_URL=postgresql://allodium_ro:readonly@localhost:5433/allodium_dev

\set ON_ERROR_STOP on

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'allodium_ro') THEN
    CREATE ROLE allodium_ro LOGIN PASSWORD 'readonly';
  END IF;
END
$$;

-- Explicitly NOT superuser, NOT createdb, NOT createrole, and no BYPASSRLS.
ALTER ROLE allodium_ro NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;

-- Cap runtime at the role level too (a SET can raise it, but the guard blocks that).
ALTER ROLE allodium_ro SET statement_timeout = '10s';
-- Belt and braces: default every transaction this role opens to read-only.
ALTER ROLE allodium_ro SET default_transaction_read_only = on;

GRANT CONNECT ON DATABASE allodium_dev TO allodium_ro;
GRANT USAGE ON SCHEMA public TO allodium_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO allodium_ro;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO allodium_ro;

-- Tables the Schema silo creates later must be readable too, without re-running this.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO allodium_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON SEQUENCES TO allodium_ro;

-- Revoke the function-execution surface that leaks the filesystem/host. These are
-- superuser-only by default, but be explicit: this role is the untrusted lane.
REVOKE ALL ON FUNCTION pg_read_file(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION pg_read_file(text, bigint, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION pg_ls_dir(text) FROM PUBLIC;
