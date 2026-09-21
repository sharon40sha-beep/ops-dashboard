-- ============================================================================
-- OPS Dashboard — Supabase migration
-- הרץ את הקובץ הזה כולו ב-Supabase SQL Editor (Dashboard -> SQL Editor -> New query)
-- הכל idempotent: אפשר להריץ שוב בבטחה.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.sites (
  id   text primary key,                 -- "S01".."S06" (מחסנים), "S07" (מפעל), אפשר להוסיף
  kind text not null check (kind in ('warehouse', 'factory', 'other'))
);

create table if not exists public.assets (
  id           text primary key,         -- "A1".."A6"
  home_site_id text not null references public.sites(id)
);

create table if not exists public.employees (
  id   uuid primary key default gen_random_uuid(),
  name text not null,
  pin  text not null,                     -- קוד PIN קצר (4 ספרות)
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

create index if not exists tasks_worker_status_idx on public.tasks (worker_id, status);
create index if not exists tasks_status_idx        on public.tasks (status);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- מערכת פנימית סגורה ל-5 משתמשים (לא public app). anon key מזוהה כ"מורשה".
-- select / insert / update — פתוחים. delete — לא נחשף ל-client (אין policy).
-- ---------------------------------------------------------------------------

alter table public.sites     enable row level security;
alter table public.assets    enable row level security;
alter table public.employees enable row level security;
alter table public.tasks     enable row level security;

-- sites — read-only reference data
drop policy if exists sites_select on public.sites;
create policy sites_select on public.sites for select to anon, authenticated using (true);

-- assets — read-only reference data
drop policy if exists assets_select on public.assets;
create policy assets_select on public.assets for select to anon, authenticated using (true);

-- employees — קריאה בלבד מה-client (לצורך רשימת התחברות ואימות PIN)
drop policy if exists employees_select on public.employees;
create policy employees_select on public.employees for select to anon, authenticated using (true);

-- tasks — עובר עדכונים לאורך חייו (checklist, start, actual, complete) => update מותר
drop policy if exists tasks_select on public.tasks;
create policy tasks_select on public.tasks for select to anon, authenticated using (true);

drop policy if exists tasks_insert on public.tasks;
create policy tasks_insert on public.tasks for insert to anon, authenticated with check (true);

drop policy if exists tasks_update on public.tasks;
create policy tasks_update on public.tasks for update to anon, authenticated using (true) with check (true);

-- (בכוונה אין policy ל-delete בשום טבלה — לא ניתן למחוק מה-client)

-- ---------------------------------------------------------------------------
-- Realtime — הוספת tasks ל-publication כדי שסנכרון בזמן אמת יעבוד
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'tasks'
  ) then
    alter publication supabase_realtime add table public.tasks;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Seed data
-- ---------------------------------------------------------------------------

-- 6 מחסנים (S01..S06) + מפעל אחד משותף (S07)
insert into public.sites (id, kind) values
  ('S01', 'warehouse'),
  ('S02', 'warehouse'),
  ('S03', 'warehouse'),
  ('S04', 'warehouse'),
  ('S05', 'warehouse'),
  ('S06', 'warehouse'),
  ('S07', 'factory')
on conflict (id) do update set kind = excluded.kind;

-- 6 מוצרים, כל אחד עם מחסן-בית עצמאי משלו
insert into public.assets (id, home_site_id) values
  ('A1', 'S01'),
  ('A2', 'S02'),
  ('A3', 'S03'),
  ('A4', 'S04'),
  ('A5', 'S05'),
  ('A6', 'S06')
on conflict (id) do update set home_site_id = excluded.home_site_id;

-- עובדים (5 משתמשים) — שנה את ה-PIN-ים לפני שימוש אמיתי!
-- מזהים קבועים כדי שהרצה חוזרת לא תיצור כפילויות.
insert into public.employees (id, name, pin, role) values
  ('00000000-0000-0000-0000-000000000001', 'מנהל',   '1234', 'admin'),
  ('00000000-0000-0000-0000-000000000002', 'עובד 1', '1111', 'operator'),
  ('00000000-0000-0000-0000-000000000003', 'עובד 2', '2222', 'operator'),
  ('00000000-0000-0000-0000-000000000004', 'עובד 3', '3333', 'operator'),
  ('00000000-0000-0000-0000-000000000005', 'עובד 4', '4444', 'operator')
on conflict (id) do update set name = excluded.name, role = excluded.role;

-- ---------------------------------------------------------------------------
-- בדיקת חיבור מהירה (הרץ אחרי המיגרציה כדי לוודא):
--   select count(*) from public.sites;      -- אמור להחזיר 7
--   select count(*) from public.assets;     -- אמור להחזיר 6
--   select count(*) from public.employees;  -- אמור להחזיר 5
-- ---------------------------------------------------------------------------
