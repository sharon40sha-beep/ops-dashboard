-- =============================================================================
-- OPS Dashboard — seed data (fixed reference set for this phase)
-- Safe to re-run: guarded by ON CONFLICT / NOT EXISTS.
--
-- Login PINs (CHANGE THESE before real use):
--   מנהל   → 1234  (admin)
--   עובד 1 → 1111  (operator)
--   עובד 2 → 2222  (operator)
--   עובד 3 → 3333  (operator)
--   עובד 4 → 4444  (operator)
-- =============================================================================

-- 6 warehouses (S01..S06) + one shared factory (S07)
insert into public.sites (id, kind) values
  ('S01', 'warehouse'),
  ('S02', 'warehouse'),
  ('S03', 'warehouse'),
  ('S04', 'warehouse'),
  ('S05', 'warehouse'),
  ('S06', 'warehouse'),
  ('S07', 'factory')
on conflict (id) do update set kind = excluded.kind;

-- 6 assets, each with its own independent home warehouse
insert into public.assets (id, home_site_id) values
  ('A1', 'S01'),
  ('A2', 'S02'),
  ('A3', 'S03'),
  ('A4', 'S04'),
  ('A5', 'S05'),
  ('A6', 'S06')
on conflict (id) do update set home_site_id = excluded.home_site_id;

-- 5 employees (fixed ids so re-running never duplicates)
insert into public.employees (id, name, pin, role) values
  ('00000000-0000-0000-0000-000000000001', 'מנהל',   '1234', 'admin'),
  ('00000000-0000-0000-0000-000000000002', 'עובד 1', '1111', 'operator'),
  ('00000000-0000-0000-0000-000000000003', 'עובד 2', '2222', 'operator'),
  ('00000000-0000-0000-0000-000000000004', 'עובד 3', '3333', 'operator'),
  ('00000000-0000-0000-0000-000000000005', 'עובד 4', '4444', 'operator')
on conflict (id) do update set name = excluded.name, role = excluded.role;

-- Quick check:
--   select count(*) from public.sites;      -- 7
--   select count(*) from public.assets;     -- 6
--   select * from public.list_login_employees();  -- 5 rows, no pin column
