-- Allodium dev seed 003 — permissions model + files.
--
-- Additive on top of 001 (blog) and 002 (commerce + user classes). Two jobs:
--
--   1. role_permissions — the v1 permissions strawman for the console's
--      Roles & Permissions silo: UNIFIED role→permissions (no policy indirection),
--      one row per role × table with four CRUD flags. Deliberately simple; iterate
--      in place as the console grows an enforcement layer.
--   2. files — the metadata table for @allodium/storage's bytes (per the package's
--      doctrine: metadata lives in the consumer's DB where FKs can reach it), plus
--      FK columns from products/authors into it so the Files silo has the
--      "referenced by other tables" situation to render.
--
-- Coverage added: bigint column (files.filesize_bytes), a second uuid-PK table,
-- table-name-driven grants (role_permissions.table_name is a soft reference —
-- deliberately NOT an FK, since tables aren't rows; drift shows in the console).
--
-- Apply:  docker exec -i allodium-dev-pg psql -U chapterhub_user -d allodium_dev \
--           -v ON_ERROR_STOP=1 < dev/seed/003-permissions-and-files.sql

\set ON_ERROR_STOP on
BEGIN;

-- ---------------------------------------------------------------------------
-- Files — metadata only; bytes live under the console's UPLOADS_DIR via
-- @allodium/storage. disk_name is the app-generated {uuid}.{ext}.
-- ---------------------------------------------------------------------------

CREATE TABLE files (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  disk_name      varchar(255) NOT NULL UNIQUE,
  filename       varchar(255) NOT NULL,
  mime_type      varchar(120),
  filesize_bytes bigint,
  title          varchar(200),
  uploaded_at    timestamptz  NOT NULL DEFAULT now()
);

ALTER TABLE products ADD COLUMN image_id  uuid REFERENCES files(id) ON DELETE SET NULL;
ALTER TABLE authors  ADD COLUMN avatar_id uuid REFERENCES files(id) ON DELETE SET NULL;

-- Seeded metadata rows. The bytes deliberately do NOT exist on disk — the Files
-- silo must render the missing-on-disk state gracefully (metadata and bytes are
-- separate systems that CAN disagree; the console should show that, not hide it).
INSERT INTO files (disk_name, filename, mime_type, filesize_bytes, title) VALUES
  ('1f0e2d3c-0000-4000-8000-000000000001.jpg', 'ethiopia-bag.jpg',   'image/jpeg', 184320, 'Ethiopia Yirgacheffe bag shot'),
  ('1f0e2d3c-0000-4000-8000-000000000002.jpg', 'house-blend-bag.jpg','image/jpeg', 176450, 'House Blend bag shot'),
  ('1f0e2d3c-0000-4000-8000-000000000003.png', 'ada-avatar.png',     'image/png',   48212, 'Ada avatar'),
  ('1f0e2d3c-0000-4000-8000-000000000004.pdf', 'wholesale-sheet.pdf','application/pdf', 402113, 'Wholesale price sheet');

UPDATE products SET image_id = (SELECT id FROM files WHERE filename = 'ethiopia-bag.jpg')
WHERE sku = 'CF-ETH-250';
UPDATE products SET image_id = (SELECT id FROM files WHERE filename = 'house-blend-bag.jpg')
WHERE sku = 'CF-HSE-340';
UPDATE authors SET avatar_id = (SELECT id FROM files WHERE filename = 'ada-avatar.png')
WHERE email = 'ada@example.com';

-- ---------------------------------------------------------------------------
-- Role permissions — unified matrix: role × table × CRUD flags.
-- ---------------------------------------------------------------------------

CREATE TABLE role_permissions (
  id         serial PRIMARY KEY,
  role_id    integer      NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  table_name varchar(120) NOT NULL,
  can_create boolean      NOT NULL DEFAULT false,
  can_read   boolean      NOT NULL DEFAULT false,
  can_update boolean      NOT NULL DEFAULT false,
  can_delete boolean      NOT NULL DEFAULT false,
  UNIQUE (role_id, table_name)
);

-- admin: full CRUD on every table that exists right now (dynamic, so it includes
-- files and role_permissions themselves). super_admin intentionally gets NO rows:
-- the console lane bypasses the permissions model entirely, and an all-true row
-- set would wrongly imply it's governed by it.
INSERT INTO role_permissions (role_id, table_name, can_create, can_read, can_update, can_delete)
SELECT r.id, t.tablename, true, true, true, true
FROM pg_tables t, roles r
WHERE t.schemaname = 'public' AND r.key = 'admin';

-- support: work orders and customers, look at users/products, touch nothing else.
INSERT INTO role_permissions (role_id, table_name, can_create, can_read, can_update, can_delete)
SELECT r.id, v.tbl, v.c, v.r, v.u, v.d
FROM roles r,
     (VALUES ('orders',      false, true, true,  false),
             ('order_items', false, true, true,  false),
             ('customers',   true,  true, true,  false),
             ('users',       false, true, false, false),
             ('products',    false, true, false, false)) AS v(tbl, c, r, u, d)
WHERE r.key = 'support';

-- marketing: owns the blog, reads the catalog.
INSERT INTO role_permissions (role_id, table_name, can_create, can_read, can_update, can_delete)
SELECT r.id, v.tbl, v.c, v.r, v.u, v.d
FROM roles r,
     (VALUES ('posts',      true,  true, true,  true),
             ('comments',   false, true, true,  true),
             ('tags',       true,  true, true,  true),
             ('post_tags',  true,  true, true,  true),
             ('authors',    true,  true, true,  false),
             ('files',      true,  true, true,  false),
             ('products',   false, true, false, false),
             ('categories', false, true, false, false)) AS v(tbl, c, r, u, d)
WHERE r.key = 'marketing';

-- member: no grants at all — the empty state is meaningful (no admin surface).

COMMIT;
