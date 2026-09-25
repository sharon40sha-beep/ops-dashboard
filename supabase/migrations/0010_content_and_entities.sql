-- =============================================================================
-- OPS Dashboard — 0010: flexible checklist, content mgmt, learning summary,
-- entity management. (Numbering: 0009 was taken by tasks_rpcs, so this is 0010.)
--
--  A  Checklist: "critical" is guidance only. Any item can be skipped; Start is
--     always allowed, but if anything is unchecked a skip-note is required.
--  B  checklist_items table + admin RPCs; create_task copies active items.
--  C  (client only) remove the fake "GPS" indicator.
--  D  admin_asset_summary — learning board (hours / vehicle / worker / route /
--     deviations) over a date range; needs tasks.started_at.
--  E  routes + vehicles tables; is_active on assets/sites; admin CRUD RPCs for
--     assets/sites/routes/vehicles. Pickers read active rows only.
--
-- Depends on 0008 (_session_admin/_session_employee) and 0009 (tasks RPCs).
-- Safe to re-run. idempotent.
-- =============================================================================

set search_path = public, extensions;

-- ============================================================================
-- Schema
-- ============================================================================

-- B: managed checklist template
create table if not exists public.checklist_items (
  id         uuid primary key default gen_random_uuid(),
  label      text not null,
  critical   boolean not null default false,
  sort_order integer not null default 0,
  is_active  boolean not null default true
);
alter table public.checklist_items enable row level security;
-- closed: only admin RPCs (and create_task, as owner) touch it.

-- seed the 5 defaults once
insert into public.checklist_items (label, critical, sort_order, is_active)
select v.label, v.critical, v.sort_order, true
from (values
  ('בוצעה תצפית',        true,  1),
  ('לא זוהו חריגים',     true,  2),
  ('סביבת היציאה נבדקה', false, 3),
  ('הרכב מוכן',          false, 4),
  ('תקשורת תקינה',       false, 5)
) as v(label, critical, sort_order)
where not exists (select 1 from public.checklist_items);

-- D: departure timestamp
alter table public.tasks add column if not exists started_at timestamptz;

-- E: soft-delete flags on reference tables + new code tables
alter table public.sites  add column if not exists is_active boolean not null default true;
alter table public.assets add column if not exists is_active boolean not null default true;

create table if not exists public.routes (
  id        text primary key,
  is_active boolean not null default true
);
create table if not exists public.vehicles (
  id        text primary key,
  is_active boolean not null default true
);

insert into public.routes (id) values ('Blue'), ('Green'), ('Red')
  on conflict (id) do nothing;
insert into public.vehicles (id) values ('V-1'), ('V-2')
  on conflict (id) do nothing;

-- routes/vehicles are just codes (non-sensitive) — open SELECT for the pickers,
-- same as sites/assets. Writes go only through the admin RPCs.
alter table public.routes   enable row level security;
alter table public.vehicles enable row level security;
drop policy if exists routes_select   on public.routes;
drop policy if exists vehicles_select on public.vehicles;
create policy routes_select   on public.routes   for select to anon, authenticated using (true);
create policy vehicles_select on public.vehicles for select to anon, authenticated using (true);
grant select on public.routes   to anon, authenticated;
grant select on public.vehicles to anon, authenticated;

-- ============================================================================
-- A + B: checklist behaviour + content management
-- ============================================================================

-- create_task now copies the ACTIVE checklist template (label + critical).
create or replace function public.create_task(
  session_token text,
  asset_id      text,
  from_site_id  text,
  to_site_id    text,
  worker_id     uuid,
  vehicle       text,
  route         text,
  time_window   text
)
returns public.tasks
language plpgsql
volatile
security definer
set search_path = public
as $$
declare v_task public.tasks; v_checklist jsonb;
begin
  perform public._session_admin(session_token);
  select coalesce(
           jsonb_agg(jsonb_build_object('label', ci.label, 'critical', ci.critical, 'checked', false)
                     order by ci.sort_order, ci.label),
           '[]'::jsonb)
    into v_checklist
    from public.checklist_items ci
   where ci.is_active = true;

  insert into public.tasks
    (asset_id, from_site_id, to_site_id, worker_id, vehicle, route, time_window, status, checklist, actual, audit_log)
  values
    (create_task.asset_id, create_task.from_site_id, create_task.to_site_id, create_task.worker_id,
     coalesce(create_task.vehicle, ''), coalesce(create_task.route, ''), coalesce(create_task.time_window, ''),
     'planned', v_checklist, null,
     jsonb_build_array(to_char(now(), 'HH24:MI') || ' – Task created'))
  returning * into v_task;
  return v_task;
end;
$$;

-- start_task: skips allowed; require a note if anything is unchecked; stamp started_at.
drop function if exists public.start_task(text, uuid);
create function public.start_task(session_token text, task_id uuid, skip_note text)
returns public.tasks
language plpgsql
volatile
security definer
set search_path = public
as $$
declare v_id uuid; v_task public.tasks; v_unchecked boolean;
begin
  v_id := public._session_employee(session_token);
  select * into v_task from public.tasks t where t.id = task_id;
  if not found then raise exception 'task not found' using errcode = 'P0002'; end if;
  if v_task.worker_id <> v_id then raise exception 'not your task' using errcode = '42501'; end if;
  if v_task.status <> 'planned' then raise exception 'task is not in planned state' using errcode = '22023'; end if;

  v_unchecked := exists (
    select 1 from jsonb_array_elements(v_task.checklist) el
    where coalesce((el->>'checked')::boolean, false) = false
  );
  if v_unchecked and coalesce(btrim(skip_note), '') = '' then
    raise exception 'skip note required' using errcode = '22023';
  end if;

  update public.tasks t
     set status = 'active',
         started_at = now(),
         audit_log = v_task.audit_log || jsonb_build_array(
           to_char(now(), 'HH24:MI') ||
           case when v_unchecked then ' – Task started (skipped; note: ' || btrim(skip_note) || ')'
                else ' – Task started' end)
   where t.id = task_id
   returning * into v_task;
  return v_task;
end;
$$;

-- B: checklist template admin
create or replace function public.admin_list_checklist_items(session_token text)
returns setof public.checklist_items
language plpgsql stable security definer set search_path = public
as $$
begin
  perform public._session_admin(session_token);
  return query select * from public.checklist_items order by sort_order, label;
end;
$$;

create or replace function public.admin_add_checklist_item(session_token text, label text, critical boolean, sort_order integer)
returns void
language plpgsql volatile security definer set search_path = public
as $$
begin
  perform public._session_admin(session_token);
  if coalesce(btrim(label), '') = '' then raise exception 'label required' using errcode = '22023'; end if;
  insert into public.checklist_items (label, critical, sort_order, is_active)
  values (btrim(admin_add_checklist_item.label), coalesce(admin_add_checklist_item.critical, false),
          coalesce(admin_add_checklist_item.sort_order, 0), true);
end;
$$;

create or replace function public.admin_update_checklist_item(
  session_token text, id uuid, label text, critical boolean, sort_order integer, is_active boolean)
returns void
language plpgsql volatile security definer set search_path = public
as $$
begin
  perform public._session_admin(session_token);
  update public.checklist_items ci
     set label = btrim(admin_update_checklist_item.label),
         critical = coalesce(admin_update_checklist_item.critical, ci.critical),
         sort_order = coalesce(admin_update_checklist_item.sort_order, ci.sort_order),
         is_active = coalesce(admin_update_checklist_item.is_active, ci.is_active)
   where ci.id = admin_update_checklist_item.id;
  if not found then raise exception 'item not found' using errcode = 'P0002'; end if;
end;
$$;

-- ============================================================================
-- D: learning summary for one asset over a date range
-- ============================================================================
create or replace function public.admin_asset_summary(session_token text, asset_id text, from_date date, to_date date)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare v_json jsonb;
begin
  perform public._session_admin(session_token);
  with filt as (
    select t.*,
           coalesce(t.started_at, t.created_at) as dep
    from public.tasks t
    where t.asset_id = admin_asset_summary.asset_id
      and t.status = 'completed'
      and coalesce((t.actual->>'completed_at')::timestamptz, t.created_at)::date
          between admin_asset_summary.from_date and admin_asset_summary.to_date
  )
  select jsonb_build_object(
    'total',    (select count(*) from filt),
    'deviated', (select count(*) from filt where coalesce((actual->>'deviated')::boolean, false)),
    'hours', coalesce((
        select jsonb_agg(jsonb_build_object('hour', h, 'count', c) order by h)
        from (select extract(hour from dep)::int as h, count(*) c from filt group by 1) x), '[]'::jsonb),
    'by_vehicle', coalesce((
        select jsonb_agg(jsonb_build_object('key', k, 'count', c) order by c desc)
        from (select coalesce(nullif(btrim(actual->>'vehicle'), ''), '—') k, count(*) c from filt group by 1) x), '[]'::jsonb),
    'by_route', coalesce((
        select jsonb_agg(jsonb_build_object('key', k, 'count', c) order by c desc)
        from (select coalesce(nullif(btrim(actual->>'route'), ''), '—') k, count(*) c from filt group by 1) x), '[]'::jsonb),
    'by_worker', coalesce((
        select jsonb_agg(jsonb_build_object('key', nm, 'count', c) order by c desc)
        from (select e.name as nm, count(*) c
              from filt f join public.employees e on e.id = f.worker_id
              group by e.name) x), '[]'::jsonb)
  ) into v_json;
  return v_json;
end;
$$;

-- ============================================================================
-- E: entity management (codes only). is_active soft-delete, never physical.
-- ============================================================================

-- assets
create or replace function public.admin_list_assets(session_token text)
returns table (id text, home_site_id text, is_active boolean)
language plpgsql stable security definer set search_path = public
as $$
begin
  perform public._session_admin(session_token);
  return query select a.id, a.home_site_id, a.is_active from public.assets a order by a.id;
end;
$$;

create or replace function public.admin_add_asset(session_token text, id text, home_site_id text)
returns void language plpgsql volatile security definer set search_path = public
as $$
begin
  perform public._session_admin(session_token);
  if coalesce(btrim(admin_add_asset.id), '') = '' then raise exception 'code required' using errcode = '22023'; end if;
  insert into public.assets (id, home_site_id, is_active)
  values (btrim(admin_add_asset.id), admin_add_asset.home_site_id, true);
end;
$$;

create or replace function public.admin_update_asset(session_token text, id text, home_site_id text, is_active boolean)
returns void language plpgsql volatile security definer set search_path = public
as $$
begin
  perform public._session_admin(session_token);
  update public.assets a
     set home_site_id = coalesce(admin_update_asset.home_site_id, a.home_site_id),
         is_active = coalesce(admin_update_asset.is_active, a.is_active)
   where a.id = admin_update_asset.id;
  if not found then raise exception 'asset not found' using errcode = 'P0002'; end if;
end;
$$;

-- sites
create or replace function public.admin_list_sites(session_token text)
returns table (id text, kind text, is_active boolean)
language plpgsql stable security definer set search_path = public
as $$
begin
  perform public._session_admin(session_token);
  return query select s.id, s.kind, s.is_active from public.sites s order by s.id;
end;
$$;

create or replace function public.admin_add_site(session_token text, id text, kind text)
returns void language plpgsql volatile security definer set search_path = public
as $$
begin
  perform public._session_admin(session_token);
  if coalesce(btrim(admin_add_site.id), '') = '' then raise exception 'code required' using errcode = '22023'; end if;
  if admin_add_site.kind not in ('warehouse', 'factory', 'other') then raise exception 'bad kind' using errcode = '22023'; end if;
  insert into public.sites (id, kind, is_active) values (btrim(admin_add_site.id), admin_add_site.kind, true);
end;
$$;

create or replace function public.admin_update_site(session_token text, id text, kind text, is_active boolean)
returns void language plpgsql volatile security definer set search_path = public
as $$
begin
  perform public._session_admin(session_token);
  if admin_update_site.kind is not null and admin_update_site.kind not in ('warehouse', 'factory', 'other') then
    raise exception 'bad kind' using errcode = '22023';
  end if;
  update public.sites s
     set kind = coalesce(admin_update_site.kind, s.kind),
         is_active = coalesce(admin_update_site.is_active, s.is_active)
   where s.id = admin_update_site.id;
  if not found then raise exception 'site not found' using errcode = 'P0002'; end if;
end;
$$;

-- routes
create or replace function public.admin_list_routes(session_token text)
returns table (id text, is_active boolean)
language plpgsql stable security definer set search_path = public
as $$
begin
  perform public._session_admin(session_token);
  return query select r.id, r.is_active from public.routes r order by r.id;
end;
$$;

create or replace function public.admin_add_route(session_token text, id text)
returns void language plpgsql volatile security definer set search_path = public
as $$
begin
  perform public._session_admin(session_token);
  if coalesce(btrim(admin_add_route.id), '') = '' then raise exception 'code required' using errcode = '22023'; end if;
  insert into public.routes (id, is_active) values (btrim(admin_add_route.id), true);
end;
$$;

create or replace function public.admin_update_route(session_token text, id text, is_active boolean)
returns void language plpgsql volatile security definer set search_path = public
as $$
begin
  perform public._session_admin(session_token);
  update public.routes r set is_active = coalesce(admin_update_route.is_active, r.is_active)
   where r.id = admin_update_route.id;
  if not found then raise exception 'route not found' using errcode = 'P0002'; end if;
end;
$$;

-- vehicles
create or replace function public.admin_list_vehicles(session_token text)
returns table (id text, is_active boolean)
language plpgsql stable security definer set search_path = public
as $$
begin
  perform public._session_admin(session_token);
  return query select v.id, v.is_active from public.vehicles v order by v.id;
end;
$$;

create or replace function public.admin_add_vehicle(session_token text, id text)
returns void language plpgsql volatile security definer set search_path = public
as $$
begin
  perform public._session_admin(session_token);
  if coalesce(btrim(admin_add_vehicle.id), '') = '' then raise exception 'code required' using errcode = '22023'; end if;
  insert into public.vehicles (id, is_active) values (btrim(admin_add_vehicle.id), true);
end;
$$;

create or replace function public.admin_update_vehicle(session_token text, id text, is_active boolean)
returns void language plpgsql volatile security definer set search_path = public
as $$
begin
  perform public._session_admin(session_token);
  update public.vehicles v set is_active = coalesce(admin_update_vehicle.is_active, v.is_active)
   where v.id = admin_update_vehicle.id;
  if not found then raise exception 'vehicle not found' using errcode = 'P0002'; end if;
end;
$$;

-- ============================================================================
-- Privileges
-- ============================================================================
grant execute on function public.start_task(text, uuid, text)                                    to anon, authenticated;
grant execute on function public.admin_list_checklist_items(text)                                 to anon, authenticated;
grant execute on function public.admin_add_checklist_item(text, text, boolean, integer)           to anon, authenticated;
grant execute on function public.admin_update_checklist_item(text, uuid, text, boolean, integer, boolean) to anon, authenticated;
grant execute on function public.admin_asset_summary(text, text, date, date)                      to anon, authenticated;
grant execute on function public.admin_list_assets(text)                                          to anon, authenticated;
grant execute on function public.admin_add_asset(text, text, text)                                to anon, authenticated;
grant execute on function public.admin_update_asset(text, text, text, boolean)                    to anon, authenticated;
grant execute on function public.admin_list_sites(text)                                           to anon, authenticated;
grant execute on function public.admin_add_site(text, text, text)                                 to anon, authenticated;
grant execute on function public.admin_update_site(text, text, text, boolean)                     to anon, authenticated;
grant execute on function public.admin_list_routes(text)                                          to anon, authenticated;
grant execute on function public.admin_add_route(text, text)                                      to anon, authenticated;
grant execute on function public.admin_update_route(text, text, boolean)                          to anon, authenticated;
grant execute on function public.admin_list_vehicles(text)                                        to anon, authenticated;
grant execute on function public.admin_add_vehicle(text, text)                                    to anon, authenticated;
grant execute on function public.admin_update_vehicle(text, text, boolean)                        to anon, authenticated;

-- ----------------------------------------------------------------------------
-- Verify (with a valid admin token):
--   select * from public.admin_list_checklist_items('<token>');
--   select public.admin_asset_summary('<token>','A1', current_date - 30, current_date);
--   select * from public.admin_list_routes('<token>');
-- ----------------------------------------------------------------------------
