-- =============================================================================
-- OPS Dashboard — table privileges (fixes: 42501 "permission denied for table")
--
-- RLS decides WHICH ROWS a role may touch; Postgres GRANTs decide whether the
-- role may touch the table AT ALL. The policies in 0001 were correct, but the
-- anon/authenticated roles were missing the underlying table privileges, so
-- every query failed with 42501 before RLS was ever evaluated.
--
-- Privileges here mirror the RLS policies exactly:
--   sites  / assets : SELECT only (read-only reference data)
--   tasks           : SELECT + INSERT + UPDATE (no DELETE)
--   employees       : NONE — deliberately not granted. The client reaches it
--                     only through the SECURITY DEFINER RPCs (which already
--                     have EXECUTE granted in 0001). Do NOT grant on employees.
--
-- Safe to re-run. idempotent.
-- =============================================================================

-- Schema usage (defensive — normally already present on public).
grant usage on schema public to anon, authenticated;

-- Reference data — read only.
grant select on public.sites  to anon, authenticated;
grant select on public.assets to anon, authenticated;

-- Tasks — read + create + update across the task lifecycle (no delete).
grant select, insert, update on public.tasks to anon, authenticated;

-- employees stays ungranted on purpose. Belt-and-suspenders: make sure no
-- direct table privilege leaked to the client roles.
revoke all on public.employees from anon, authenticated;

-- Keep future tables in public from silently lacking grants for these roles.
-- (Optional hardening; comment out if you prefer to grant per-table only.)
-- alter default privileges in schema public grant select on tables to anon, authenticated;

-- ----------------------------------------------------------------------------
-- Verify (run as anon to confirm; e.g. from the app or with the anon key):
--   select count(*) from public.sites;   -- should succeed now
--   select count(*) from public.assets;  -- should succeed now
--   select count(*) from public.tasks;   -- should succeed now
--   select count(*) from public.employees; -- should STILL fail / return nothing
-- ----------------------------------------------------------------------------
