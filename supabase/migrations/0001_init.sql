-- =============================================================================
-- OPS Dashboard — initial schema
-- הרץ ב-Supabase SQL Editor (או `supabase db push`) פעם אחת. idempotent.
--
-- Design notes:
--  * INTERNAL tool for ~5 known users. No full Supabase Auth — identification
--    is a short PIN. RLS is permissive for the anon/publishable key on the
--    operational tables, EXCEPT the employees table, which is fully locked:
--    it is NOT selectable by the client, so PINs never reach the browser.
--    Login goes through SECURITY DEFINER RPCs (list_login_employees, verify_pin).
--  * tasks are updated across their lifecycle (checklist, start, actual,
--    complete) so UPDATE is allowed; no DELETE from the client on any table.
--  * Only codes are stored (A#, S##, route names) — never real-world names.
-- =============================================================================

create extension if not exists "pgcrypto";

-- ----------------------------------------------------------------------------
-- Tables
-- ----------------------------------------------------------------------------
create table if not exists public.sites (
  id   text primary key,                 -- 'S01'..'S06' warehouses, 'S07' factory, extendable
  kind text not null check (kind in ('warehouse', 'factory', 'other'))
);

create table if not exists public.assets (
  id           text primary key,         -- 'A1'..'A6'
  home_site_id text not null references public.sites(id)
);

create table if not exists public.employees (
  id   uuid primary key default gen_random_uuid(),
  name text not null,
  pin  text not null,                     -- 4-digit PIN — NEVER exposed to the client
  role text not null check (role in ('admin', 'operator'))
);

create table if not exists public.tasks (
  id           uuid primary key default gen_random_uuid(),
  asset_id     text not null references public.assets(id),
  from_site_id text not null references public.sites(id),
  to_site_id   text not null references public.sites(id),
  worker_id    uuid not null references public.employees(id),
  vehicle      text not null default '',
  route        text not null default '',
  time_window  text not null default '',
  status       text not null default 'planned' check (status in ('planned', 'active', 'completed')),
  checklist    jsonb not null default '[]'::jsonb,   -- [{label, checked}]
  actual       jsonb,                                -- {vehicle, route, completed_at, deviated, reason}
  audit_log    jsonb not null default '[]'::jsonb,   -- ["08:05 – Task created", ...]
  created_at   timestamptz not null default now()
);

create index if not exists idx_tasks_worker_status on public.tasks (worker_id, status);
create index if not exists idx_tasks_status        on public.tasks (status);
create index if not exists idx_tasks_created_at    on public.tasks (created_at desc);

-- ----------------------------------------------------------------------------
-- Row Level Security
--   sites / assets : SELECT only (read-only reference data)
--   employees      : NO client access at all (RLS on, zero policies => deny).
--                    Reached only through SECURITY DEFINER functions below.
--   tasks          : SELECT + INSERT + UPDATE (no DELETE)
-- ----------------------------------------------------------------------------
alter table public.sites     enable row level security;
alter table public.assets    enable row level security;
alter table public.employees enable row level security;
alter table public.tasks     enable row level security;

-- sites
drop policy if exists sites_select on public.sites;
create policy sites_select on public.sites for select to anon, authenticated using (true);

-- assets
drop policy if exists assets_select on public.assets;
create policy assets_select on public.assets for select to anon, authenticated using (true);

-- employees — LOCKED DOWN. Remove any legacy open policy; add none.
drop policy if exists employees_select on public.employees;

-- tasks
drop policy if exists tasks_select on public.tasks;
create policy tasks_select on public.tasks for select to anon, authenticated using (true);
drop policy if exists tasks_insert on public.tasks;
create policy tasks_insert on public.tasks for insert to anon, authenticated with check (true);
drop policy if exists tasks_update on public.tasks;
create policy tasks_update on public.tasks for update to anon, authenticated using (true) with check (true);

-- ----------------------------------------------------------------------------
-- SECURITY DEFINER RPCs — the ONLY way the client touches employees.
-- They run as the function owner (postgres), bypassing RLS, and expose
-- id/name/role only. PINs are compared inside the DB and never returned.
-- ----------------------------------------------------------------------------

-- Employee list for the login screen and the "worker" dropdown (no PIN).
create or replace function public.list_login_employees()
returns table (id uuid, name text, role text)
language sql
stable
security definer
set search_path = public
as $$
  select e.id, e.name, e.role
  from public.employees e
  order by e.role, e.name;
$$;

-- Verify a PIN. Returns the matching employee (id/name/role) or no rows.
create or replace function public.verify_pin(emp_id uuid, pin_input text)
returns table (id uuid, name text, role text)
language sql
stable
security definer
set search_path = public
as $$
  select e.id, e.name, e.role
  from public.employees e
  where e.id = emp_id and e.pin = pin_input;
$$;

revoke all on function public.list_login_employees() from public;
revoke all on function public.verify_pin(uuid, text) from public;
grant execute on function public.list_login_employees() to anon, authenticated;
grant execute on function public.verify_pin(uuid, text) to anon, authenticated;

-- ----------------------------------------------------------------------------
-- Realtime — broadcast changes on tasks
-- ----------------------------------------------------------------------------
alter table public.tasks replica identity full;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'tasks'
  ) then
    alter publication supabase_realtime add table public.tasks;
  end if;
end $$;
