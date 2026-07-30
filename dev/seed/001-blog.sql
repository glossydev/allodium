-- Allodium dev seed 001 — the blog domain (base schema).
--
-- PROVENANCE: this file was reconstructed from the live `allodium_dev` database on
-- 2026-07-29. The original tables were created ad hoc (no script), which meant the
-- seed set could not rebuild a fresh database — seeds 002-004 all assume these five
-- tables already exist. Reconstructed so `001 → 004` is actually reproducible.
--
-- Deliberately the SMALL, familiar domain: a blog with authors, posts, tags and
-- comments. Seeds 002+ add the commerce/identity domains on top and bridge into
-- these tables (authors.user_id, authors.avatar_id, comments.parent_id are added
-- there, NOT here — keep it that way or 002/003 will fail on re-run).
--
-- Apply:  docker exec -i allodium-dev-pg psql -U chapterhub_user -d allodium_dev \
--           -v ON_ERROR_STOP=1 < dev/seed/001-blog.sql

\set ON_ERROR_STOP on
BEGIN;

CREATE TABLE authors (
  id        serial PRIMARY KEY,
  name      varchar(120) NOT NULL,
  email     varchar(200) UNIQUE,
  bio       text,
  verified  boolean     DEFAULT false,
  joined_at timestamptz DEFAULT now()
);

CREATE TABLE posts (
  id           serial PRIMARY KEY,
  author_id    integer      NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
  title        varchar(200) NOT NULL,
  slug         varchar(200) NOT NULL UNIQUE,
  body         text,
  status       varchar(16)  DEFAULT 'draft',
  views        integer      DEFAULT 0,
  price        numeric(10,2),
  published_at timestamptz,
  created_at   timestamptz  DEFAULT now()
);

CREATE TABLE tags (
  id    serial PRIMARY KEY,
  label varchar(60) NOT NULL UNIQUE
);

-- Composite-PK join table: the original many-to-many in the fixture set.
CREATE TABLE post_tags (
  post_id integer NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  tag_id  integer NOT NULL REFERENCES tags(id)  ON DELETE CASCADE,
  PRIMARY KEY (post_id, tag_id)
);

CREATE TABLE comments (
  id          serial PRIMARY KEY,
  post_id     integer      NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  author_name varchar(120),
  body        text         NOT NULL,
  approved    boolean      DEFAULT false,
  created_at  timestamptz  DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Data. Emails here are matched by seed 002 to create marketing users, which is
-- what wires authors.user_id — grace@ deliberately gets no account so that FK
-- keeps a NULL case.
-- ---------------------------------------------------------------------------

INSERT INTO authors (name, email, bio, verified) VALUES
  ('Ada Lovelace', 'ada@example.com',   'First programmer.',   true),
  ('Alan Turing',  'alan@example.com',  'Computing pioneer.',  true),
  ('Grace Hopper', 'grace@example.com', NULL,                  false);

INSERT INTO posts (author_id, title, slug, body, status, views, price, published_at) VALUES
  (1, 'On Analytical Engines', 'analytical-engines', 'Long-form body...',      'published', 1204, NULL,  now() - interval '10 days'),
  (1, 'Notes on Loops',        'notes-on-loops',     'Draft body...',          'draft',        0, NULL,  NULL),
  (2, 'Can Machines Think',    'can-machines-think', '...',                    'published', 8890, NULL,  now() - interval '3 days'),
  (3, 'The First Compiler',    'first-compiler',     '...',                    'published',  430, 9.99,  now() - interval '1 day');

INSERT INTO tags (label) VALUES ('history'), ('cs'), ('tutorial'), ('essay');

INSERT INTO post_tags (post_id, tag_id) VALUES
  (1, 1), (1, 4),
  (2, 3),
  (3, 2), (3, 4),
  (4, 1), (4, 2);

-- One unapproved comment from the start, so the moderation path has a case.
INSERT INTO comments (post_id, author_name, body, approved) VALUES
  (1, 'reader1', 'Fascinating!',            true),
  (1, 'reader2', 'Spam link',               false),
  (3, 'reader3', 'Great essay',             true),
  (4, 'reader4', 'Thanks for the tutorial', true);

COMMIT;
