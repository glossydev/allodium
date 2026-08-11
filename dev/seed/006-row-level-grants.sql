-- Allodium dev seed 006 — the public role, and grants that can restrict ROWS.
--
-- Run against the container from docs/getting-started.md:
--   docker exec -i allodium-dev-pg psql -U allodium -d allodium_dev -v ON_ERROR_STOP=1 < dev/seed/006-row-level-grants.sql
--
-- Two things a table x action matrix cannot say, both of which the harness needs:
--
--   1. WHO an unauthenticated request is. Anonymous is not an absence of an actor,
--      it is an actor holding one role — so it gets a row, and its reach is edited
--      in the same screen as every other role rather than in a second system.
--
--   2. WHICH ROWS a grant covers. "A member sees their own orders" is a grant on
--      orders restricted to customer_id = the actor's customer. row_filter holds
--      that as the same predicate shape the view runtime already speaks, so it is
--      handed to the query layer without translation.
--
-- Idempotent: safe to re-run, and safe on a database seeded before this file existed.

alter table role_permissions add column if not exists row_filter jsonb;

comment on column role_permissions.row_filter is
  'Predicates restricting which rows this grant covers, e.g. [{"column":"customer_id","op":"eq","value":"$actor.customerId"}]. Null or [] means every row. $actor.<claim> resolves per request.';

-- The anonymous role. Ranked last: it is the least privileged thing that exists.
insert into roles (key, label, description, rank)
values ('public', 'Public', 'Anonymous visitors. Anything granted here is readable by the whole internet.', 1000)
on conflict (key) do nothing;

-- What the internet may read on the demo: published posts and their authors.
-- Deliberately narrow — this is the row that decides what leaks.
insert into role_permissions (role_id, table_name, can_create, can_read, can_update, can_delete, row_filter)
select r.id, v.table_name, false, true, false, false, v.row_filter::jsonb
  from roles r
  cross join (values
    ('posts',      '[{"column":"status","op":"eq","value":"published"}]'),
    ('authors',    null),
    ('tags',       null),
    ('post_tags',  null)
  ) as v(table_name, row_filter)
 where r.key = 'public'
on conflict (role_id, table_name) do update
   set can_read = excluded.can_read, row_filter = excluded.row_filter;

-- A member sees their OWN orders and nobody else's. This is the grant the matrix
-- could not express, and the reason row_filter exists.
insert into role_permissions (role_id, table_name, can_create, can_read, can_update, can_delete, row_filter)
select r.id, v.table_name, false, true, false, false, v.row_filter::jsonb
  from roles r
  cross join (values
    ('orders',      '[{"column":"customer_id","op":"eq","value":"$actor.customerId"}]'),
    ('order_items', null)
  ) as v(table_name, row_filter)
 where r.key = 'member'
on conflict (role_id, table_name) do update
   set can_read = excluded.can_read, row_filter = excluded.row_filter;

-- Support reads orders unrestricted: the case that proves a second role RAISES a
-- member's reach rather than lowering it, since a person may hold both.
insert into role_permissions (role_id, table_name, can_create, can_read, can_update, can_delete)
select r.id, 'orders', false, true, true, false from roles r where r.key = 'support'
on conflict (role_id, table_name) do update set can_read = excluded.can_read, can_update = excluded.can_update;

do $$
declare
  n_public int;
  n_member int;
begin
  select count(*) into n_public from role_permissions rp join roles r on r.id = rp.role_id where r.key = 'public';
  select count(*) into n_member from role_permissions rp join roles r on r.id = rp.role_id
   where r.key = 'member' and rp.row_filter is not null;
  if n_public < 4 then
    raise exception 'public role should have 4 grants, found %', n_public;
  end if;
  if n_member < 1 then
    raise exception 'member should have at least one row-restricted grant, found %', n_member;
  end if;
  -- super_admin holds no grants ON PURPOSE: it bypasses the model, and rows here
  -- would read as if they were consulted. The gate asserts the same rule.
  if exists (select 1 from role_permissions rp join roles r on r.id = rp.role_id where r.key = 'super_admin') then
    raise exception 'super_admin must hold zero grants — it bypasses the model';
  end if;
end $$;
