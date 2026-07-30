-- Allodium dev seed 002 — commerce domain + user classes.
--
-- Additive on top of seed 001 (the blog: authors/posts/tags/post_tags/comments).
-- Nothing here drops or rewrites 001; the two ALTERs at the bottom only add nullable
-- columns to existing tables.
--
-- This seed has two jobs at once:
--   1. Feel tangible — a small store with real-looking products, customers and orders,
--      plus the user classes an admin surface actually has to distinguish.
--   2. Exercise every metadata path the developer console has to render. Each shape
--      below is here on purpose; see the coverage notes.
--
-- Coverage notes (what would otherwise be untested):
--   masked columns .......... users.password_hash, users.mfa_secret
--   self-referencing FK ..... categories.parent_id, comments.parent_id
--   nullable FK ............. customers.user_id (guest checkout), products.category_id,
--                             order_items.product_id (product deleted), authors.user_id
--   real pg ENUM ............ user_status, order_status
--   uuid PK ................. users (mixed PK types alongside 001's serials)
--   jsonb ................... products.attributes, orders.shipping_address
--   text[] .................. products.tags
--   date (not timestamp) .... customers.birth_date
--   1:1 relation ............ customers.user_id UNIQUE -> users
--   many:many + payload ..... user_roles (composite PK, carries granted_at/granted_by)
--   wide table .............. products (14 columns)
--   volume .................. ~260 orders / ~640 order_items for pagination + sorting
--
-- Apply:  docker exec -i allodium-dev-pg psql -U chapterhub_user -d allodium_dev \
--           -v ON_ERROR_STOP=1 < dev/seed/002-commerce-and-users.sql

\set ON_ERROR_STOP on
BEGIN;

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------

CREATE TYPE user_status  AS ENUM ('active', 'invited', 'suspended', 'deactivated');
CREATE TYPE order_status AS ENUM ('pending', 'paid', 'packed', 'shipped', 'delivered',
                                  'cancelled', 'refunded');

-- ---------------------------------------------------------------------------
-- Identity — the user classes
--
-- One users table, many roles, granted through a join table. A person can hold more
-- than one role at once (staff who also shop), which is why this is many:many rather
-- than a role column. Granting a role is one of the admin dashboard's core jobs, so
-- the grant itself carries provenance: who granted it and when.
-- ---------------------------------------------------------------------------

CREATE TABLE roles (
  id          serial PRIMARY KEY,
  key         varchar(40)  NOT NULL UNIQUE,
  label       varchar(80)  NOT NULL,
  description text,
  -- Rank orders privilege: lower is more powerful. The console uses it to decide
  -- which roles the current operator is allowed to grant.
  rank        integer      NOT NULL DEFAULT 100
);

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         varchar(200) NOT NULL UNIQUE,
  display_name  varchar(120),
  -- MASKED. Never selected, never editable, never on the wire.
  password_hash varchar(255) NOT NULL,
  -- MASKED. Null until the user enrolls a second factor.
  mfa_secret    varchar(64),
  status        user_status  NOT NULL DEFAULT 'invited',
  last_login_at timestamptz,
  created_at    timestamptz  NOT NULL DEFAULT now()
);

CREATE TABLE user_roles (
  user_id    uuid    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id    integer NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  granted_at timestamptz NOT NULL DEFAULT now(),
  -- Nullable + self-referential through users: system-granted roles have no granter.
  granted_by uuid REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (user_id, role_id)
);

CREATE INDEX user_roles_role_id_idx ON user_roles (role_id);

-- ---------------------------------------------------------------------------
-- Catalog
-- ---------------------------------------------------------------------------

CREATE TABLE categories (
  id        serial PRIMARY KEY,
  name      varchar(80)  NOT NULL,
  slug      varchar(80)  NOT NULL UNIQUE,
  -- Self-referencing: top-level categories have no parent.
  parent_id integer REFERENCES categories(id) ON DELETE SET NULL
);

CREATE TABLE products (
  id           serial PRIMARY KEY,
  sku          varchar(32)   NOT NULL UNIQUE,
  name         varchar(160)  NOT NULL,
  description  text,
  -- Nullable: uncategorized products are legal.
  category_id  integer REFERENCES categories(id) ON DELETE SET NULL,
  price        numeric(10,2) NOT NULL,
  cost         numeric(10,2),
  currency     char(3)       NOT NULL DEFAULT 'USD',
  stock        integer       NOT NULL DEFAULT 0,
  weight_grams integer,
  active       boolean       NOT NULL DEFAULT true,
  attributes   jsonb         NOT NULL DEFAULT '{}'::jsonb,
  tags         text[]        NOT NULL DEFAULT '{}',
  created_at   timestamptz   NOT NULL DEFAULT now(),
  updated_at   timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX products_category_id_idx ON products (category_id);

-- ---------------------------------------------------------------------------
-- Customers — a profile hanging off users, 1:1 via the UNIQUE FK.
-- user_id is nullable so guest checkout has somewhere to live: a customer record
-- with no login. That distinction (customer vs. user) is exactly what the two
-- admin lanes disagree about, so the test data should carry both.
-- ---------------------------------------------------------------------------

CREATE TABLE customers (
  id               serial PRIMARY KEY,
  user_id          uuid UNIQUE REFERENCES users(id) ON DELETE SET NULL,
  full_name        varchar(160) NOT NULL,
  email            varchar(200) NOT NULL,
  phone            varchar(40),
  company          varchar(160),
  birth_date       date,
  marketing_opt_in boolean      NOT NULL DEFAULT false,
  notes            text,
  created_at       timestamptz  NOT NULL DEFAULT now()
);

CREATE INDEX customers_email_idx ON customers (email);

-- ---------------------------------------------------------------------------
-- Orders
-- ---------------------------------------------------------------------------

CREATE TABLE orders (
  id               serial PRIMARY KEY,
  order_number     varchar(20)   NOT NULL UNIQUE,
  customer_id      integer       NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  status           order_status  NOT NULL DEFAULT 'pending',
  subtotal         numeric(10,2) NOT NULL DEFAULT 0,
  tax              numeric(10,2) NOT NULL DEFAULT 0,
  shipping         numeric(10,2) NOT NULL DEFAULT 0,
  total            numeric(10,2) NOT NULL DEFAULT 0,
  shipping_address jsonb,
  placed_at        timestamptz   NOT NULL DEFAULT now(),
  shipped_at       timestamptz,
  notes            text
);

CREATE INDEX orders_customer_id_idx ON orders (customer_id);
CREATE INDEX orders_status_idx      ON orders (status);
CREATE INDEX orders_placed_at_idx   ON orders (placed_at DESC);

CREATE TABLE order_items (
  id         serial PRIMARY KEY,
  order_id   integer       NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  -- Nullable: a discontinued product is deleted, the line item survives with its
  -- captured name and price. Relation pickers have to render this unset state.
  product_id integer REFERENCES products(id) ON DELETE SET NULL,
  name_at_purchase varchar(160)  NOT NULL,
  quantity   integer       NOT NULL DEFAULT 1,
  unit_price numeric(10,2) NOT NULL,
  line_total numeric(10,2) NOT NULL
);

CREATE INDEX order_items_order_id_idx   ON order_items (order_id);
CREATE INDEX order_items_product_id_idx ON order_items (product_id);

-- ---------------------------------------------------------------------------
-- Data: roles
-- ---------------------------------------------------------------------------

INSERT INTO roles (key, label, description, rank) VALUES
  ('super_admin', 'Super Admin',    'Full access including schema, SQL and role grants. Developer console lane.', 0),
  ('admin',       'Administrator',  'Full dashboard access. Cannot reach the developer console.',                 10),
  ('support',     'Customer Service','Reads customers, manages orders and refunds. No user or schema access.',     20),
  ('marketing',   'Marketing',      'Authors and publishes blog content. Read-only on commerce.',                  30),
  ('member',      'Member',         'A signed-in customer. No admin surface at all.',                             100);

-- ---------------------------------------------------------------------------
-- Data: users
--
-- Four named staff spanning the lanes, then 40 generated members. Every hash below is
-- the same throwaway argon2id digest for the password "devpassword" — this database is
-- a local toy, and the column is masked in the console anyway.
-- ---------------------------------------------------------------------------

INSERT INTO users (email, display_name, password_hash, mfa_secret, status, last_login_at, created_at) VALUES
  ('adam@glossydev.com',      'Adam Aronoff',  '$argon2id$v=19$m=65536,t=3,p=4$ZGV2c2FsdGRldnNhbHQ$0000000000000000000000000000000000000000000', 'JBSWY3DPEHPK3PXP', 'active',      now() - interval '2 hours', now() - interval '120 days'),
  ('dana@example.com',        'Dana Whitfield','$argon2id$v=19$m=65536,t=3,p=4$ZGV2c2FsdGRldnNhbHQ$0000000000000000000000000000000000000000000', 'KRSXG5CTMVRXEZLU', 'active',      now() - interval '1 day',   now() - interval '90 days'),
  ('marco@example.com',       'Marco Reyes',   '$argon2id$v=19$m=65536,t=3,p=4$ZGV2c2FsdGRldnNhbHQ$0000000000000000000000000000000000000000000', NULL,               'active',      now() - interval '5 days',  now() - interval '60 days'),
  ('priya@example.com',       'Priya Nandakumar','$argon2id$v=19$m=65536,t=3,p=4$ZGV2c2FsdGRldnNhbHQ$0000000000000000000000000000000000000000000', NULL,             'active',      now() - interval '3 days',  now() - interval '45 days'),
  ('sam.locke@example.com',   'Sam Locke',     '$argon2id$v=19$m=65536,t=3,p=4$ZGV2c2FsdGRldnNhbHQ$0000000000000000000000000000000000000000000', NULL,               'suspended',   now() - interval '80 days', now() - interval '200 days'),
  ('newhire@example.com',     'Jordan Bell',   '$argon2id$v=19$m=65536,t=3,p=4$ZGV2c2FsdGRldnNhbHQ$0000000000000000000000000000000000000000000', NULL,               'invited',     NULL,                       now() - interval '2 days'),
  -- These two match seed 001's blog authors by email, which is what wires authors.user_id
  -- below. They carry the marketing role: the people who add to the blog are dashboard
  -- users, not console users. Seed 001's third author (grace@) deliberately gets NO
  -- account — an external guest contributor, so authors.user_id keeps a NULL case.
  ('ada@example.com',         'Ada Lovelace',  '$argon2id$v=19$m=65536,t=3,p=4$ZGV2c2FsdGRldnNhbHQ$0000000000000000000000000000000000000000000', NULL,               'active',      now() - interval '4 days',  now() - interval '150 days'),
  ('alan@example.com',        'Alan Turing',   '$argon2id$v=19$m=65536,t=3,p=4$ZGV2c2FsdGRldnNhbHQ$0000000000000000000000000000000000000000000', NULL,               'active',      now() - interval '9 days',  now() - interval '140 days');

-- 40 members, deterministic and varied: a few deactivated, most active, staggered signup.
INSERT INTO users (email, display_name, password_hash, status, last_login_at, created_at)
SELECT
  'member' || i || '@example.com',
  (ARRAY['Alex','Bailey','Casey','Devon','Emerson','Finley','Gray','Harper','Indigo','Jules',
         'Kendall','Lane','Morgan','Noor','Oakley','Parker','Quinn','Riley','Sawyer','Tatum'])[1 + (i % 20)]
    || ' ' ||
  (ARRAY['Abbott','Bergman','Castellanos','Dunn','Ellsworth','Farooqi','Gallagher','Hsu','Ibarra','Jain',
         'Kowalski','Lindqvist','Mbeki','Nakamura','Oyelaran','Petrov','Quintero','Rasmussen','Silva','Thorne'])[1 + ((i * 7) % 20)],
  '$argon2id$v=19$m=65536,t=3,p=4$ZGV2c2FsdGRldnNhbHQ$0000000000000000000000000000000000000000000',
  CASE WHEN i % 17 = 0 THEN 'deactivated'::user_status
       WHEN i % 13 = 0 THEN 'invited'::user_status
       ELSE 'active'::user_status END,
  CASE WHEN i % 5 = 0 THEN NULL ELSE now() - (i || ' days')::interval END,
  now() - ((180 - i * 3) || ' days')::interval
FROM generate_series(1, 40) AS i;

-- ---------------------------------------------------------------------------
-- Data: role grants
--
-- Adam is super_admin AND admin — deliberately, so the console has a multi-role user
-- to render. Marco holds support, Priya marketing, Dana admin. Everyone else is a
-- member. Adam's own grant is system-issued (granted_by NULL); he granted the rest.
-- ---------------------------------------------------------------------------

INSERT INTO user_roles (user_id, role_id, granted_by, granted_at)
SELECT u.id, r.id, NULL, u.created_at
FROM users u JOIN roles r ON r.key IN ('super_admin', 'admin')
WHERE u.email = 'adam@glossydev.com';

INSERT INTO user_roles (user_id, role_id, granted_by, granted_at)
SELECT u.id,
       r.id,
       (SELECT id FROM users WHERE email = 'adam@glossydev.com'),
       u.created_at + interval '1 day'
FROM users u
JOIN roles r ON r.key = CASE u.email
                          WHEN 'dana@example.com'      THEN 'admin'
                          WHEN 'marco@example.com'     THEN 'support'
                          WHEN 'priya@example.com'     THEN 'marketing'
                          WHEN 'sam.locke@example.com' THEN 'support'
                          WHEN 'newhire@example.com'   THEN 'support'
                          WHEN 'ada@example.com'       THEN 'marketing'
                          WHEN 'alan@example.com'      THEN 'marketing'
                        END
WHERE u.email IN ('dana@example.com', 'marco@example.com', 'priya@example.com',
                  'sam.locke@example.com', 'newhire@example.com',
                  'ada@example.com', 'alan@example.com');

INSERT INTO user_roles (user_id, role_id, granted_by, granted_at)
SELECT u.id, (SELECT id FROM roles WHERE key = 'member'), NULL, u.created_at
FROM users u
WHERE u.email LIKE 'member%@example.com';

-- ---------------------------------------------------------------------------
-- Data: categories — two levels, so parent_id actually has something in it.
-- ---------------------------------------------------------------------------

INSERT INTO categories (name, slug, parent_id) VALUES
  ('Coffee',      'coffee',      NULL),
  ('Equipment',   'equipment',   NULL),
  ('Merch',       'merch',       NULL);

INSERT INTO categories (name, slug, parent_id) VALUES
  ('Single Origin', 'single-origin', (SELECT id FROM categories WHERE slug = 'coffee')),
  ('Blends',        'blends',        (SELECT id FROM categories WHERE slug = 'coffee')),
  ('Decaf',         'decaf',         (SELECT id FROM categories WHERE slug = 'coffee')),
  ('Grinders',      'grinders',      (SELECT id FROM categories WHERE slug = 'equipment')),
  ('Brewers',       'brewers',       (SELECT id FROM categories WHERE slug = 'equipment')),
  ('Apparel',       'apparel',       (SELECT id FROM categories WHERE slug = 'merch'));

-- ---------------------------------------------------------------------------
-- Data: products — jsonb attributes and text[] tags vary per row on purpose.
-- One product is deliberately left uncategorized (category_id NULL).
-- ---------------------------------------------------------------------------

INSERT INTO products (sku, name, description, category_id, price, cost, stock, weight_grams, active, attributes, tags) VALUES
  ('CF-ETH-250',  'Ethiopia Yirgacheffe 250g', 'Floral and bright, washed process. Notes of bergamot and stone fruit.', (SELECT id FROM categories WHERE slug='single-origin'), 21.00, 9.40,  84, 250, true,  '{"roast":"light","process":"washed","altitude_m":2100}', '{coffee,single-origin,light-roast}'),
  ('CF-COL-250',  'Colombia Huila 250g',       'Balanced and sweet — caramel, red apple, cocoa finish.',                (SELECT id FROM categories WHERE slug='single-origin'), 18.50, 8.10, 132, 250, true,  '{"roast":"medium","process":"washed","altitude_m":1750}', '{coffee,single-origin}'),
  ('CF-KEN-250',  'Kenya Nyeri AA 250g',       'Blackcurrant, grapefruit, huge acidity. A loud coffee.',                (SELECT id FROM categories WHERE slug='single-origin'), 24.00, 11.20, 41, 250, true,  '{"roast":"light","process":"washed","altitude_m":1900}', '{coffee,single-origin,light-roast,limited}'),
  ('CF-SUM-250',  'Sumatra Mandheling 250g',   'Earthy, syrupy, low acid. Wet-hulled.',                                 (SELECT id FROM categories WHERE slug='single-origin'), 19.00, 8.60,  0,  250, true,  '{"roast":"dark","process":"wet-hulled"}',                 '{coffee,single-origin,dark-roast}'),
  ('CF-HSE-340',  'House Blend 340g',          'The everyday bag. Chocolate, almond, brown sugar.',                     (SELECT id FROM categories WHERE slug='blends'),        16.00, 6.75, 260, 340, true,  '{"roast":"medium","components":3}',                       '{coffee,blend,bestseller}'),
  ('CF-ESP-340',  'Espresso Blend 340g',       'Built for pressure. Thick body, cocoa, dried cherry.',                  (SELECT id FROM categories WHERE slug='blends'),        17.50, 7.20, 198, 340, true,  '{"roast":"medium-dark","components":4}',                  '{coffee,blend,espresso}'),
  ('CF-BRK-340',  'Breakfast Blend 340g',      'Gentle, sweet, forgiving. The one for the office.',                     (SELECT id FROM categories WHERE slug='blends'),        15.50, 6.40, 175, 340, true,  '{"roast":"light-medium","components":2}',                 '{coffee,blend}'),
  ('CF-DEC-250',  'Decaf Sugarcane 250g',      'Sugarcane EA process. Actually good, genuinely.',                       (SELECT id FROM categories WHERE slug='decaf'),         19.50, 9.00,  62, 250, true,  '{"roast":"medium","process":"sugarcane-ea","caffeine_mg":4}', '{coffee,decaf}'),
  ('CF-DEC-340',  'Decaf House 340g',          'The house blend, minus the reason people drink it.',                    (SELECT id FROM categories WHERE slug='decaf'),         18.00, 8.20,  38, 340, false, '{"roast":"medium","process":"swiss-water"}',              '{coffee,decaf,discontinued}'),
  ('EQ-GRD-01',   'Hand Grinder — Stainless',  'Conical burr, 40mm, external adjustment.',                              (SELECT id FROM categories WHERE slug='grinders'),      89.00, 41.00,  27, 640, true,  '{"burr":"conical","burr_mm":40,"material":"stainless"}',  '{equipment,grinder,manual}'),
  ('EQ-GRD-02',   'Electric Grinder — Matte',  '64mm flat burr, stepless. Loud. Worth it.',                             (SELECT id FROM categories WHERE slug='grinders'),     349.00, 178.00,  9, 4200, true, '{"burr":"flat","burr_mm":64,"stepless":true}',            '{equipment,grinder,electric,premium}'),
  ('EQ-BRW-V60',  'Pourover Cone — Ceramic',   'Size 02, spiral ribs, cone filter.',                                    (SELECT id FROM categories WHERE slug='brewers'),       28.00, 11.50, 143, 380, true,  '{"size":"02","material":"ceramic"}',                      '{equipment,brewer,pourover}'),
  ('EQ-BRW-PRS',  'French Press 800ml',        'Borosilicate, steel frame, dishwasher safe.',                           (SELECT id FROM categories WHERE slug='brewers'),       42.00, 18.00,  76, 920, true,  '{"volume_ml":800,"material":"borosilicate"}',             '{equipment,brewer,immersion}'),
  ('EQ-BRW-AER',  'Immersion Brewer',          'Plastic, indestructible, faintly ridiculous, excellent.',               (SELECT id FROM categories WHERE slug='brewers'),       39.00, 16.00, 112, 450, true,  '{"volume_ml":250,"material":"polypropylene"}',            '{equipment,brewer,immersion,travel}'),
  ('EQ-SCL-01',   'Brew Scale 0.1g',           'Two-decimal, built-in timer, USB-C.',                                   (SELECT id FROM categories WHERE slug='equipment'),     64.00, 28.00,  53, 610, true,  '{"precision_g":0.1,"timer":true,"charging":"usb-c"}',     '{equipment,scale}'),
  ('MR-TEE-BLK',  'Logo Tee — Black',          'Heavyweight cotton, boxy fit.',                                         (SELECT id FROM categories WHERE slug='apparel'),       32.00, 12.00, 210, 220, true,  '{"sizes":["S","M","L","XL"],"material":"cotton"}',        '{merch,apparel}'),
  ('MR-HAT-NVY',  'Six-Panel Cap — Navy',      'Unstructured, adjustable strap.',                                       (SELECT id FROM categories WHERE slug='apparel'),       28.00, 10.50,  88, 110, true,  '{"adjustable":true,"material":"cotton-twill"}',           '{merch,apparel}'),
  ('MR-MUG-12',   'Ceramic Mug 12oz',          'Thick walls, holds heat, survives being dropped once.',                 (SELECT id FROM categories WHERE slug='merch'),         22.00,  8.00, 164, 480, true,  '{"volume_oz":12,"dishwasher_safe":true}',                 '{merch,drinkware}'),
  ('MR-TMB-16',   'Travel Tumbler 16oz',       'Vacuum sealed, leakproof lid.',                                         (SELECT id FROM categories WHERE slug='merch'),         38.00, 15.00,  95, 390, true,  '{"volume_oz":16,"insulated":true}',                      '{merch,drinkware,travel}'),
  ('MSC-GIFT-50', 'Gift Card $50',             'Digital delivery. No expiry.',                                          NULL,                                                   50.00,  0.00,   0,   0, true,  '{"digital":true,"value_usd":50}',                         '{gift-card,digital}');

-- ---------------------------------------------------------------------------
-- Data: customers
--
-- Every member user gets a customer profile (user_id set). Then 12 guest customers
-- with user_id NULL — people who checked out without an account. Two named staff also
-- shop, because real systems blur that line and the console should show it.
-- ---------------------------------------------------------------------------

INSERT INTO customers (user_id, full_name, email, phone, company, birth_date, marketing_opt_in, created_at)
SELECT
  u.id,
  COALESCE(u.display_name, 'Member'),
  u.email,
  '+1-555-' || lpad(((row_number() OVER (ORDER BY u.created_at)) * 37 % 10000)::text, 4, '0'),
  NULL,
  DATE '1970-01-01' + ((row_number() OVER (ORDER BY u.created_at)) * 431 % 12000)::integer,
  (row_number() OVER (ORDER BY u.created_at)) % 3 <> 0,
  u.created_at
FROM users u
WHERE u.email LIKE 'member%@example.com';

INSERT INTO customers (user_id, full_name, email, phone, company, birth_date, marketing_opt_in, created_at)
SELECT u.id, u.display_name, u.email, '+1-555-0100', 'GlossyDev', DATE '1985-04-12', true, u.created_at
FROM users u WHERE u.email IN ('adam@glossydev.com', 'dana@example.com');

INSERT INTO customers (user_id, full_name, email, phone, company, birth_date, marketing_opt_in, created_at)
SELECT
  NULL,
  (ARRAY['Wren Ashby','Ola Adeyemi','Teo Marchetti','Ines Duarte','Kai Lindgren','Nadia Haddad',
         'Rory Chen','Sasha Volkov','Mila Novak','Ari Ben-David','Yusuf Kaya','Elise Moreau'])[i],
  'guest' || i || '@example.com',
  NULL,
  (ARRAY[NULL,NULL,'Marchetti Roasters',NULL,NULL,'Haddad & Co',NULL,NULL,NULL,'BD Consulting',NULL,NULL])[i],
  NULL,
  false,
  now() - ((i * 9) || ' days')::interval
FROM generate_series(1, 12) AS i;

-- ---------------------------------------------------------------------------
-- Data: orders — ~260 rows spread over 18 months, weighted toward recent.
-- Status distribution is realistic: mostly delivered, a tail of live and unhappy ones.
-- ---------------------------------------------------------------------------

INSERT INTO orders (order_number, customer_id, status, placed_at, shipped_at, shipping_address, notes)
SELECT
  'ORD-' || lpad(i::text, 5, '0'),
  1 + (i * 17) % (SELECT count(*)::integer FROM customers),
  CASE
    WHEN i % 23 = 0 THEN 'cancelled'::order_status
    WHEN i % 31 = 0 THEN 'refunded'::order_status
    WHEN i % 11 = 0 THEN 'pending'::order_status
    WHEN i % 9  = 0 THEN 'paid'::order_status
    WHEN i % 7  = 0 THEN 'packed'::order_status
    WHEN i % 5  = 0 THEN 'shipped'::order_status
    ELSE 'delivered'::order_status
  END,
  now() - ((i * 2) || ' days')::interval,
  CASE WHEN i % 11 = 0 OR i % 23 = 0 OR i % 9 = 0 THEN NULL
       ELSE now() - ((i * 2 - 2) || ' days')::interval END,
  jsonb_build_object(
    'line1', (100 + i * 3) || ' ' || (ARRAY['Maple St','Oak Ave','Cedar Ln','Birch Rd','Elm Way'])[1 + (i % 5)],
    'city',  (ARRAY['Portland','Austin','Providence','Boulder','Savannah','Missoula'])[1 + (i % 6)],
    'region',(ARRAY['OR','TX','RI','CO','GA','MT'])[1 + (i % 6)],
    'postal', lpad(((i * 613) % 99999)::text, 5, '0'),
    'country', 'US'
  ),
  CASE WHEN i % 19 = 0 THEN 'Leave at side door.' ELSE NULL END
FROM generate_series(1, 260) AS i;

-- 1–4 line items per order, drawn from the catalog. Gift cards excluded from
-- random draw so the numbers stay sane.
INSERT INTO order_items (order_id, product_id, name_at_purchase, quantity, unit_price, line_total)
SELECT
  o.id,
  p.id,
  p.name,
  q.quantity,
  p.price,
  round(p.price * q.quantity, 2)
FROM orders o
CROSS JOIN LATERAL (
  SELECT 1 + ((o.id * 3 + gs) % 3) AS quantity, gs
  FROM generate_series(0, (o.id % 4)) AS gs
) q
JOIN LATERAL (
  SELECT id, name, price FROM products
  WHERE sku <> 'MSC-GIFT-50'
  ORDER BY (id * 7 + o.id * 13 + q.gs * 29) % 19
  LIMIT 1
) p ON true;

-- One line item deliberately orphaned: the product was discontinued and deleted, the
-- history survives. Exercises the nullable-FK / unset-relation render path.
UPDATE order_items
SET product_id = NULL, name_at_purchase = 'Guatemala Antigua 250g (discontinued)'
WHERE id IN (SELECT id FROM order_items ORDER BY id LIMIT 3);

-- Roll the money up from the line items so the totals are internally consistent.
UPDATE orders o SET
  subtotal = t.subtotal,
  tax      = round(t.subtotal * 0.0875, 2),
  shipping = CASE WHEN t.subtotal >= 50 THEN 0 ELSE 6.95 END,
  total    = round(t.subtotal * 1.0875, 2) + CASE WHEN t.subtotal >= 50 THEN 0 ELSE 6.95 END
FROM (SELECT order_id, sum(line_total) AS subtotal FROM order_items GROUP BY order_id) t
WHERE t.order_id = o.id;

-- ---------------------------------------------------------------------------
-- Bridges into seed 001's blog tables — additive columns only.
-- ---------------------------------------------------------------------------

-- Blog authors become real users where the emails line up; the rest stay standalone.
ALTER TABLE authors ADD COLUMN user_id uuid REFERENCES users(id) ON DELETE SET NULL;

UPDATE authors a SET user_id = u.id
FROM users u WHERE lower(u.email) = lower(a.email);

-- Threaded comments: a second self-referencing FK, in a different domain from
-- categories.parent_id. Seed 001's four comments are too few to make a tree, so add
-- enough to get two levels of nesting and a moderation queue worth looking at.
ALTER TABLE comments ADD COLUMN parent_id integer REFERENCES comments(id) ON DELETE CASCADE;

-- Thread 001's second comment under its first.
UPDATE comments SET parent_id = 1 WHERE id = 2;

INSERT INTO comments (post_id, author_name, body, approved, created_at) VALUES
  (1, 'Marco Reyes',       'Does the engine handle conditional branching, or just sequences?', true,  now() - interval '20 days'),
  (1, 'Ada Lovelace',      'Branching, yes — that is the whole point of the jump card.',       true,  now() - interval '19 days'),
  (1, 'Wren Ashby',        'Follow-up: any worked example of the jump card?',                  true,  now() - interval '18 days'),
  (3, 'Ola Adeyemi',       'The imitation game framing still feels like a dodge to me.',       true,  now() - interval '14 days'),
  (3, 'Alan Turing',       'It is a dodge. That is the argument — the question was ill-posed.', true, now() - interval '13 days'),
  (3, 'guest_reader',      'BUY CHEAP WATCHES',                                                false, now() - interval '12 days'),
  (4, 'Teo Marchetti',     'Step three lost me. What is the intermediate representation?',     true,  now() - interval '9 days'),
  (4, 'Grace Hopper',      'Fair — it is a symbol table plus a call stack. Rewriting that bit.', true, now() - interval '8 days'),
  (4, 'Nadia Haddad',      'Would love a diagram here.',                                       true,  now() - interval '7 days'),
  (2, 'Priya Nandakumar',  'Holding this one until the loop diagrams land.',                   false, now() - interval '6 days');

-- Wire the replies. Matching on body keeps the intent readable and survives whatever
-- ids the serial happens to hand out.
UPDATE comments c SET parent_id = p.id FROM comments p
WHERE p.body = 'Does the engine handle conditional branching, or just sequences?'
  AND c.body IN ('Branching, yes — that is the whole point of the jump card.');

UPDATE comments c SET parent_id = p.id FROM comments p
WHERE p.body = 'Branching, yes — that is the whole point of the jump card.'
  AND c.body = 'Follow-up: any worked example of the jump card?';   -- two levels deep

UPDATE comments c SET parent_id = p.id FROM comments p
WHERE p.body = 'The imitation game framing still feels like a dodge to me.'
  AND c.body = 'It is a dodge. That is the argument — the question was ill-posed.';

UPDATE comments c SET parent_id = p.id FROM comments p
WHERE p.body = 'Step three lost me. What is the intermediate representation?'
  AND c.body = 'Fair — it is a symbol table plus a call stack. Rewriting that bit.';

COMMIT;
