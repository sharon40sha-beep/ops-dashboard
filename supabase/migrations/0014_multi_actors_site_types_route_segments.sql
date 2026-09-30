-- =============================================================================
-- OPS Dashboard — 0014: pre-pilot build.
--   C  Multiple workers + multiple vehicles per trip; multiple workers per shift.
--      trip_workers / trip_vehicles / duty_shift_workers replace the single
--      trips.worker_id / trips.vehicle_id / duty_shifts.worker_id columns.
--   D  site_types (managed) replaces the fixed sites.kind enum.
--   E  Rich route: trip_route_segments (ordered route legs + checkpoint notes) +
--      site_entry_points (a gate at a site). trips.planned_entry_point_id.
--      "Actual" lives inside trips.actual (jsonb): segments[], entry_point_id,
--      vehicles[]. A deviation (different route sequence / entry gate / vehicle
--      set) requires a reason, exactly like the old single-field deviation.
--
-- Analytics credit each participating worker (a 3-worker trip counts for all 3).
-- All excluded_from_analysis filters from 0013 are preserved.
--
-- Depends on 0010–0013. Data-migrates existing rows before dropping columns.
-- Safe to re-run (idempotent).
-- =============================================================================

set search_path = public, extensions;

-- ============================================================================
-- C: link tables (multiple workers / vehicles). Closed like trip_items —
--    reachable only through the SECURITY DEFINER RPCs below.
-- ============================================================================
create table if not exists public.trip_workers (
  trip_id     uuid not null references public.trips(id) on delete cascade,
  employee_id uuid not null references public.employees(id),
  primary key (trip_id, employee_id)
);
create index if not exists idx_trip_workers_emp on public.trip_workers (employee_id);
alter table public.trip_workers enable row level security;

create table if not exists public.trip_vehicles (
  trip_id    uuid not null references public.trips(id) on delete cascade,
  vehicle_id text not null references public.vehicles(id),
  primary key (trip_id, vehicle_id)
);
alter table public.trip_vehicles enable row level security;

create table if not exists public.duty_shift_workers (
  duty_shift_id uuid not null references public.duty_shifts(id) on delete cascade,
  employee_id   uuid not null references public.employees(id),
  primary key (duty_shift_id, employee_id)
);
create index if not exists idx_duty_shift_workers_emp on public.duty_shift_workers (employee_id);
alter table public.duty_shift_workers enable row level security;

-- ============================================================================
-- D: site_types (managed) — replaces sites.kind.
-- ============================================================================
create table if not exists public.site_types (
  id        uuid primary key default gen_random_uuid(),
  label     text not null,
  is_active boolean not null default true
);
alter table public.site_types enable row level security;

-- seed Hebrew labels matching the old fixed kinds, once
insert into public.site_types (label)
select v.label from (values ('מחסן'), ('מפעל'), ('מתקן')) as v(label)
where not exists (select 1 from public.site_types);

alter table public.sites add column if not exists site_type_id uuid references public.site_types(id);

-- map the old kind enum -> the seeded site_types (only where not yet mapped)
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'sites' and column_name = 'kind') then
    update public.sites set site_type_id = (select id from public.site_types where label = 'מחסן' limit 1)
      where site_type_id is null and kind = 'warehouse';
    update public.sites set site_type_id = (select id from public.site_types where label = 'מפעל' limit 1)
      where site_type_id is null and kind = 'factory';
    update public.sites set site_type_id = (select id from public.site_types where label = 'מתקן' limit 1)
      where site_type_id is null and kind = 'other';
  end if;
  -- any remaining unmapped site -> first type (safety net)
  update public.sites set site_type_id = (select id from public.site_types order by label limit 1)
    where site_type_id is null;
end $$;

-- ============================================================================
-- E: entry points + ordered route segments.
-- ============================================================================
create table if not exists public.site_entry_points (
  id        uuid primary key default gen_random_uuid(),
  site_id   text not null references public.sites(id),
  label     text not null,
  is_active boolean not null default true
);
create index if not exists idx_site_entry_points_site on public.site_entry_points (site_id);
alter table public.site_entry_points enable row level security;

create table if not exists public.trip_route_segments (
  id             uuid primary key default gen_random_uuid(),
  trip_id        uuid not null references public.trips(id) on delete cascade,
  sequence       integer not null,
  route_id       text references public.routes(id),
  checkpoint_note text
);
create index if not exists idx_trip_route_segments_trip on public.trip_route_segments (trip_id, sequence);
alter table public.trip_route_segments enable row level security;

alter table public.trips add column if not exists planned_entry_point_id uuid references public.site_entry_points(id);

-- ============================================================================
-- Data migration: fold old single columns into the new link/segment tables,
-- BEFORE the columns are dropped. Each block guarded by column existence so the
-- whole migration is safe to re-run.
-- ============================================================================
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='trips' and column_name='worker_id') then
    insert into public.trip_workers (trip_id, employee_id)
      select id, worker_id from public.trips where worker_id is not null
      on conflict do nothing;
  end if;
  if exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='trips' and column_name='vehicle_id') then
    insert into public.trip_vehicles (trip_id, vehicle_id)
      select id, vehicle_id from public.trips where nullif(btrim(vehicle_id), '') is not null
      on conflict do nothing;
  end if;
  if exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='trips' and column_name='route_id') then
    insert into public.trip_route_segments (trip_id, sequence, route_id, checkpoint_note)
      select id, 1, route_id, null from public.trips
      where nullif(btrim(route_id), '') is not null
        and not exists (select 1 from public.trip_route_segments s where s.trip_id = trips.id);
  end if;
  if exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='duty_shifts' and column_name='worker_id') then
    insert into public.duty_shift_workers (duty_shift_id, employee_id)
      select id, worker_id from public.duty_shifts where worker_id is not null
      on conflict do nothing;
  end if;
end $$;

-- ============================================================================
-- Drop the now-migrated single columns (+ their indexes go with them).
-- Functions that referenced them are all recreated further below.
-- ============================================================================
alter table public.trips       drop column if exists worker_id;
alter table public.trips       drop column if exists vehicle_id;
alter table public.trips       drop column if exists route_id;
alter table public.duty_shifts drop column if exists worker_id;
alter table public.sites       drop column if exists kind;

-- ============================================================================
-- Reference tables read by the client with the anon key (non-sensitive codes,
-- same posture as routes/vehicles): open SELECT, writes only via admin RPCs.
-- ============================================================================
drop policy if exists site_types_select   on public.site_types;
drop policy if exists site_entry_select    on public.site_entry_points;
create policy site_types_select on public.site_types        for select to anon, authenticated using (true);
create policy site_entry_select on public.site_entry_points for select to anon, authenticated using (true);
grant select on public.site_types        to anon, authenticated;
grant select on public.site_entry_points to anon, authenticated;

-- ============================================================================
-- JSON + membership helpers (internal; revoked from public).
-- ============================================================================
create or replace function public._trip_json(tr public.trips)
returns jsonb language sql stable set search_path = public
as $$
  select to_jsonb(tr) || jsonb_build_object(
    'items', coalesce((select jsonb_agg(to_jsonb(ti) order by ti.asset_id)
                       from public.trip_items ti where ti.trip_id = tr.id), '[]'::jsonb),
    'worker_ids', coalesce((select jsonb_agg(tw.employee_id)
                       from public.trip_workers tw where tw.trip_id = tr.id), '[]'::jsonb),
    'workers', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'name', e.name) order by e.name)
                       from public.trip_workers tw join public.employees e on e.id = tw.employee_id
                       where tw.trip_id = tr.id), '[]'::jsonb),
    'vehicle_ids', coalesce((select jsonb_agg(tv.vehicle_id order by tv.vehicle_id)
                       from public.trip_vehicles tv where tv.trip_id = tr.id), '[]'::jsonb),
    'route_segments', coalesce((select jsonb_agg(jsonb_build_object(
                          'sequence', s.sequence, 'route_id', s.route_id, 'checkpoint_note', s.checkpoint_note)
                          order by s.sequence)
                       from public.trip_route_segments s where s.trip_id = tr.id), '[]'::jsonb),
    'entry_point', (select ep.label from public.site_entry_points ep where ep.id = tr.planned_entry_point_id)
  );
$$;
revoke all on function public._trip_json(public.trips) from public;

create or replace function public._duty_json(ds public.duty_shifts)
returns jsonb language sql stable set search_path = public
as $$
  select to_jsonb(ds) || jsonb_build_object(
    'duty_type_label', (select dt.label from public.duty_types dt where dt.id = ds.duty_type_id),
    'worker_ids', coalesce((select jsonb_agg(w.employee_id)
                       from public.duty_shift_workers w where w.duty_shift_id = ds.id), '[]'::jsonb),
    'workers', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'name', e.name) order by e.name)
                       from public.duty_shift_workers w join public.employees e on e.id = w.employee_id
                       where w.duty_shift_id = ds.id), '[]'::jsonb)
  );
$$;
revoke all on function public._duty_json(public.duty_shifts) from public;

create or replace function public._is_trip_member(p_trip uuid, p_emp uuid)
returns boolean language sql stable set search_path = public
as $$ select exists (select 1 from public.trip_workers where trip_id = p_trip and employee_id = p_emp) $$;
revoke all on function public._is_trip_member(uuid, uuid) from public;

create or replace function public._is_duty_member(p_duty uuid, p_emp uuid)
returns boolean language sql stable set search_path = public
as $$ select exists (select 1 from public.duty_shift_workers where duty_shift_id = p_duty and employee_id = p_emp) $$;
revoke all on function public._is_duty_member(uuid, uuid) from public;

-- ============================================================================
-- Drop functions whose signature / return type changes (must drop before recreate).
-- ============================================================================
drop function if exists public.create_trip(text, text, text, uuid, text, text, text, text[], uuid);
drop function if exists public.create_duty_shift(text, text, uuid, uuid, timestamptz, timestamptz);
drop function if exists public.admin_list_sites(text);
drop function if exists public.admin_add_site(text, text, text);
drop function if exists public.admin_update_site(text, text, text, boolean);

-- ============================================================================
-- C+E: trip lifecycle (rewritten for many workers/vehicles + route segments)
-- ============================================================================
create function public.create_trip(
  session_token     text,
  from_site_id      text,
  to_site_id        text,
  worker_ids        uuid[],
  vehicle_ids       text[],
  route_segments    jsonb,
  entry_point_id    uuid,
  time_window       text,
  asset_ids         text[],
  return_of_trip_id uuid
)
returns jsonb language plpgsql volatile security definer set search_path = public
as $$
declare v_trip public.trips; v_asset text; v_tpl uuid; v_checklist jsonb;
        v_w uuid; v_v text; v_seg jsonb; v_i int := 0;
begin
  perform public._session_admin(session_token);
  if asset_ids is null or array_length(asset_ids, 1) is null then
    raise exception 'at least one asset required' using errcode = '22023';
  end if;
  if worker_ids is null or array_length(worker_ids, 1) is null then
    raise exception 'at least one worker required' using errcode = '22023';
  end if;

  insert into public.trips (from_site_id, to_site_id, time_window, status, return_of_trip_id, planned_entry_point_id, audit_log)
  values (create_trip.from_site_id, create_trip.to_site_id, coalesce(create_trip.time_window, ''),
          'planned', create_trip.return_of_trip_id, create_trip.entry_point_id,
          jsonb_build_array(to_char(now(), 'HH24:MI') || ' – Trip created'))
  returning * into v_trip;

  foreach v_w in array worker_ids loop
    insert into public.trip_workers (trip_id, employee_id) values (v_trip.id, v_w) on conflict do nothing;
  end loop;

  if vehicle_ids is not null then
    foreach v_v in array vehicle_ids loop
      if nullif(btrim(v_v), '') is not null then
        insert into public.trip_vehicles (trip_id, vehicle_id) values (v_trip.id, btrim(v_v)) on conflict do nothing;
      end if;
    end loop;
  end if;

  if route_segments is not null and jsonb_typeof(route_segments) = 'array' then
    for v_seg in select value from jsonb_array_elements(route_segments) loop
      if nullif(btrim(v_seg->>'route_id'), '') is not null then
        v_i := v_i + 1;
        insert into public.trip_route_segments (trip_id, sequence, route_id, checkpoint_note)
        values (v_trip.id, coalesce((v_seg->>'sequence')::int, v_i), btrim(v_seg->>'route_id'),
                nullif(btrim(v_seg->>'checkpoint_note'), ''));
      end if;
    end loop;
  end if;

  foreach v_asset in array asset_ids loop
    select a.checklist_template_id into v_tpl from public.assets a where a.id = v_asset;
    select coalesce(jsonb_agg(jsonb_build_object('label', ci.label, 'critical', ci.critical, 'checked', false)
                              order by ci.sort_order, ci.label), '[]'::jsonb)
      into v_checklist
      from public.checklist_items ci where ci.template_id = v_tpl and ci.is_active = true;
    insert into public.trip_items (trip_id, asset_id, checklist, checklist_note)
    values (v_trip.id, v_asset, coalesce(v_checklist, '[]'::jsonb), null);
  end loop;

  return (select public._trip_json(t) from public.trips t where t.id = v_trip.id);
end;
$$;

create or replace function public.update_trip_item_checklist(session_token text, trip_item_id uuid, p_checklist jsonb, p_note text)
returns void language plpgsql volatile security definer set search_path = public
as $$
declare v_id uuid; v_item public.trip_items; v_trip public.trips;
begin
  v_id := public._session_employee(session_token);
  select * into v_item from public.trip_items where id = trip_item_id;
  if not found then raise exception 'item not found' using errcode = 'P0002'; end if;
  select * into v_trip from public.trips where id = v_item.trip_id;
  if not public._is_trip_member(v_trip.id, v_id) then raise exception 'not your trip' using errcode = '42501'; end if;
  if v_trip.status <> 'planned' then raise exception 'trip is not editable' using errcode = '22023'; end if;
  update public.trip_items set checklist = p_checklist, checklist_note = p_note where id = trip_item_id;
end;
$$;

create or replace function public.start_trip(session_token text, trip_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = public
as $$
declare v_id uuid; v_trip public.trips; v_bad integer;
begin
  v_id := public._session_employee(session_token);
  select * into v_trip from public.trips where id = trip_id;
  if not found then raise exception 'trip not found' using errcode = 'P0002'; end if;
  if not public._is_trip_member(v_trip.id, v_id) then raise exception 'not your trip' using errcode = '42501'; end if;
  if v_trip.status <> 'planned' then raise exception 'trip is not planned' using errcode = '22023'; end if;

  select count(*) into v_bad
  from public.trip_items ti
  where ti.trip_id = start_trip.trip_id
    and exists (select 1 from jsonb_array_elements(ti.checklist) el where coalesce((el->>'checked')::boolean, false) = false)
    and coalesce(btrim(ti.checklist_note), '') = '';
  if v_bad > 0 then raise exception 'skip note required' using errcode = '22023'; end if;

  update public.trips
     set status = 'active', started_at = now(),
         audit_log = v_trip.audit_log || jsonb_build_array(to_char(now(), 'HH24:MI') || ' – Trip started')
   where id = start_trip.trip_id;
  return (select public._trip_json(t) from public.trips t where t.id = start_trip.trip_id);
end;
$$;

-- E: deviation = actual route sequence, entry gate, or vehicle set differ from plan.
create or replace function public.complete_trip(session_token text, trip_id uuid, p_actual jsonb)
returns jsonb language plpgsql volatile security definer set search_path = public
as $$
declare
  v_id uuid; v_trip public.trips; v_dev boolean; v_actual jsonb;
  v_planned_routes   text[]; v_actual_routes   text[];
  v_planned_vehicles text[]; v_actual_vehicles text[];
  v_planned_entry text; v_actual_entry text;
begin
  v_id := public._session_employee(session_token);
  select * into v_trip from public.trips where id = trip_id;
  if not found then raise exception 'trip not found' using errcode = 'P0002'; end if;
  if not public._is_trip_member(v_trip.id, v_id) then raise exception 'not your trip' using errcode = '42501'; end if;
  if v_trip.status <> 'active' then raise exception 'trip is not active' using errcode = '22023'; end if;

  -- planned (ordered) vs actual (ordered) route legs
  select array_agg(s.route_id order by s.sequence) into v_planned_routes
    from public.trip_route_segments s where s.trip_id = complete_trip.trip_id;
  select array_agg(x.rid order by x.ord) into v_actual_routes
    from (select (e.value->>'route_id') rid, e.ordinality ord
          from jsonb_array_elements(coalesce(p_actual->'segments', '[]'::jsonb)) with ordinality as e(value, ordinality)
          where nullif(btrim(e.value->>'route_id'), '') is not null) x;

  -- planned vs actual vehicle SETS (order-independent)
  select array_agg(v order by v) into v_planned_vehicles
    from (select tv.vehicle_id v from public.trip_vehicles tv where tv.trip_id = complete_trip.trip_id) q;
  select array_agg(v order by v) into v_actual_vehicles
    from (select btrim(x) v from jsonb_array_elements_text(coalesce(p_actual->'vehicles', '[]'::jsonb)) x
          where nullif(btrim(x), '') is not null) q;

  v_planned_entry := v_trip.planned_entry_point_id::text;
  v_actual_entry  := nullif(btrim(p_actual->>'entry_point_id'), '');

  v_dev := (coalesce(v_planned_routes,   '{}') is distinct from coalesce(v_actual_routes,   '{}'))
        or (coalesce(v_planned_vehicles, '{}') is distinct from coalesce(v_actual_vehicles, '{}'))
        or (v_planned_entry is distinct from v_actual_entry);

  if v_dev and coalesce(btrim(p_actual->>'reason'), '') = '' then
    raise exception 'deviation reason required' using errcode = '22023';
  end if;

  v_actual := jsonb_build_object(
    'segments',       coalesce(p_actual->'segments', '[]'::jsonb),
    'entry_point_id', v_actual_entry,
    'vehicles',       coalesce(p_actual->'vehicles', '[]'::jsonb),
    'completed_at',   now(),
    'deviated',       v_dev,
    'reason',         case when v_dev then btrim(p_actual->>'reason') else '' end
  );
  update public.trips
     set status = 'completed', actual = v_actual,
         audit_log = v_trip.audit_log || jsonb_build_array(
           to_char(now(), 'HH24:MI') || case when v_dev then ' – Trip completed (deviation logged)' else ' – Trip completed' end)
   where id = complete_trip.trip_id;
  return (select public._trip_json(t) from public.trips t where t.id = complete_trip.trip_id);
end;
$$;

-- trip lists (membership-based)
create or replace function public.list_my_trips(session_token text)
returns jsonb language plpgsql stable security definer set search_path = public
as $$
declare v_id uuid; v_out jsonb;
begin
  v_id := public._session_employee(session_token);
  select coalesce(jsonb_agg(public._trip_json(tr) order by tr.created_at desc), '[]'::jsonb) into v_out
  from public.trips tr
  where tr.status <> 'completed' and public._is_trip_member(tr.id, v_id);
  return v_out;
end;
$$;

create or replace function public.list_all_trips(session_token text)
returns jsonb language plpgsql stable security definer set search_path = public
as $$
declare v_out jsonb;
begin
  perform public._session_admin(session_token);
  select coalesce(jsonb_agg(public._trip_json(tr) order by tr.created_at desc), '[]'::jsonb) into v_out
  from public.trips tr where tr.status <> 'completed';
  return v_out;
end;
$$;

create or replace function public.list_trip_history(session_token text)
returns jsonb language plpgsql stable security definer set search_path = public
as $$
declare v_id uuid; v_role text; v_out jsonb;
begin
  v_id := public._session_employee(session_token);
  select role into v_role from public.employees where id = v_id;
  select coalesce(jsonb_agg(public._trip_json(tr) order by tr.created_at desc), '[]'::jsonb) into v_out
  from public.trips tr
  where tr.status = 'completed' and (v_role = 'admin' or public._is_trip_member(tr.id, v_id));
  return v_out;
end;
$$;

-- ============================================================================
-- C: duty shift lifecycle (rewritten for many workers)
-- ============================================================================
create function public.create_duty_shift(
  session_token text, site_id text, worker_ids uuid[], duty_type_id uuid, start_time timestamptz, end_time timestamptz)
returns jsonb language plpgsql volatile security definer set search_path = public
as $$
declare v_shift public.duty_shifts; v_tpl uuid; v_checklist jsonb; v_w uuid;
begin
  perform public._session_admin(session_token);
  if worker_ids is null or array_length(worker_ids, 1) is null then
    raise exception 'at least one worker required' using errcode = '22023';
  end if;
  select dt.checklist_template_id into v_tpl from public.duty_types dt where dt.id = create_duty_shift.duty_type_id;
  select coalesce(jsonb_agg(jsonb_build_object('label', ci.label, 'critical', ci.critical, 'checked', false)
                            order by ci.sort_order, ci.label), '[]'::jsonb)
    into v_checklist
    from public.checklist_items ci where ci.template_id = v_tpl and ci.is_active = true;

  insert into public.duty_shifts (site_id, duty_type_id, start_time, end_time, status, checklist, audit_log)
  values (create_duty_shift.site_id, create_duty_shift.duty_type_id,
          create_duty_shift.start_time, create_duty_shift.end_time, 'planned',
          coalesce(v_checklist, '[]'::jsonb),
          jsonb_build_array(to_char(now(), 'HH24:MI') || ' – Shift created'))
  returning * into v_shift;

  foreach v_w in array worker_ids loop
    insert into public.duty_shift_workers (duty_shift_id, employee_id) values (v_shift.id, v_w) on conflict do nothing;
  end loop;

  return (select public._duty_json(d) from public.duty_shifts d where d.id = v_shift.id);
end;
$$;

create or replace function public.update_duty_checklist(session_token text, duty_shift_id uuid, p_checklist jsonb, p_note text)
returns void language plpgsql volatile security definer set search_path = public
as $$
declare v_id uuid; v_shift public.duty_shifts;
begin
  v_id := public._session_employee(session_token);
  select * into v_shift from public.duty_shifts where id = duty_shift_id;
  if not found then raise exception 'shift not found' using errcode = 'P0002'; end if;
  if not public._is_duty_member(v_shift.id, v_id) then raise exception 'not your shift' using errcode = '42501'; end if;
  if v_shift.status <> 'planned' then raise exception 'shift is not editable' using errcode = '22023'; end if;
  update public.duty_shifts set checklist = p_checklist, checklist_note = p_note where id = duty_shift_id;
end;
$$;

create or replace function public.start_duty(session_token text, duty_shift_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = public
as $$
declare v_id uuid; v_shift public.duty_shifts; v_unchecked boolean;
begin
  v_id := public._session_employee(session_token);
  select * into v_shift from public.duty_shifts where id = duty_shift_id;
  if not found then raise exception 'shift not found' using errcode = 'P0002'; end if;
  if not public._is_duty_member(v_shift.id, v_id) then raise exception 'not your shift' using errcode = '42501'; end if;
  if v_shift.status <> 'planned' then raise exception 'shift is not planned' using errcode = '22023'; end if;

  v_unchecked := exists (select 1 from jsonb_array_elements(v_shift.checklist) el where coalesce((el->>'checked')::boolean, false) = false);
  if v_unchecked and coalesce(btrim(v_shift.checklist_note), '') = '' then
    raise exception 'skip note required' using errcode = '22023';
  end if;

  update public.duty_shifts set status = 'active',
    audit_log = v_shift.audit_log || jsonb_build_array(to_char(now(), 'HH24:MI') || ' – Shift started')
   where id = duty_shift_id;
  return (select public._duty_json(d) from public.duty_shifts d where d.id = duty_shift_id);
end;
$$;

create or replace function public.complete_duty(session_token text, duty_shift_id uuid, p_actual jsonb)
returns jsonb language plpgsql volatile security definer set search_path = public
as $$
declare v_id uuid; v_shift public.duty_shifts; v_anom boolean; v_actual jsonb;
begin
  v_id := public._session_employee(session_token);
  select * into v_shift from public.duty_shifts where id = duty_shift_id;
  if not found then raise exception 'shift not found' using errcode = 'P0002'; end if;
  if not public._is_duty_member(v_shift.id, v_id) then raise exception 'not your shift' using errcode = '42501'; end if;
  if v_shift.status <> 'active' then raise exception 'shift is not active' using errcode = '22023'; end if;

  v_anom := coalesce((p_actual->>'anomaly_found')::boolean, false);
  if v_anom and coalesce(btrim(p_actual->>'anomaly_notes'), '') = '' then
    raise exception 'anomaly notes required' using errcode = '22023';
  end if;
  v_actual := jsonb_build_object(
    'actual_start',  nullif(btrim(p_actual->>'actual_start'), ''),
    'actual_end',    nullif(btrim(p_actual->>'actual_end'), ''),
    'anomaly_found', v_anom,
    'anomaly_notes', case when v_anom then btrim(p_actual->>'anomaly_notes') else '' end,
    'completed_at',  now()
  );
  update public.duty_shifts set status = 'completed', actual = v_actual,
    audit_log = v_shift.audit_log || jsonb_build_array(to_char(now(), 'HH24:MI') ||
      case when v_anom then ' – Shift completed (anomaly logged)' else ' – Shift completed' end)
   where id = duty_shift_id;
  return (select public._duty_json(d) from public.duty_shifts d where d.id = duty_shift_id);
end;
$$;

create or replace function public.list_my_duties(session_token text)
returns jsonb language plpgsql stable security definer set search_path = public
as $$
declare v_id uuid; v_out jsonb;
begin
  v_id := public._session_employee(session_token);
  select coalesce(jsonb_agg(public._duty_json(ds) order by ds.created_at desc), '[]'::jsonb) into v_out
  from public.duty_shifts ds
  where ds.status <> 'completed' and public._is_duty_member(ds.id, v_id);
  return v_out;
end;
$$;

create or replace function public.list_all_duties(session_token text)
returns jsonb language plpgsql stable security definer set search_path = public
as $$
declare v_out jsonb;
begin
  perform public._session_admin(session_token);
  select coalesce(jsonb_agg(public._duty_json(ds) order by ds.created_at desc), '[]'::jsonb) into v_out
  from public.duty_shifts ds where ds.status <> 'completed';
  return v_out;
end;
$$;

create or replace function public.list_duty_history(session_token text)
returns jsonb language plpgsql stable security definer set search_path = public
as $$
declare v_id uuid; v_role text; v_out jsonb;
begin
  v_id := public._session_employee(session_token);
  select role into v_role from public.employees where id = v_id;
  select coalesce(jsonb_agg(public._duty_json(ds) order by ds.created_at desc), '[]'::jsonb) into v_out
  from public.duty_shifts ds
  where ds.status = 'completed' and (v_role = 'admin' or public._is_duty_member(ds.id, v_id));
  return v_out;
end;
$$;

-- ============================================================================
-- D: sites admin now uses site_type_id; site_types + site_entry_points CRUD.
-- ============================================================================
create function public.admin_list_sites(session_token text)
returns table (id text, site_type_id uuid, is_active boolean)
language plpgsql stable security definer set search_path = public
as $$
begin
  perform public._session_admin(session_token);
  return query select s.id, s.site_type_id, s.is_active from public.sites s order by s.id;
end;
$$;

create function public.admin_add_site(session_token text, id text, site_type_id uuid)
returns void language plpgsql volatile security definer set search_path = public
as $$
begin
  perform public._session_admin(session_token);
  if coalesce(btrim(admin_add_site.id), '') = '' then raise exception 'code required' using errcode = '22023'; end if;
  insert into public.sites (id, site_type_id, is_active) values (btrim(admin_add_site.id), admin_add_site.site_type_id, true);
end;
$$;

create function public.admin_update_site(session_token text, id text, site_type_id uuid, is_active boolean)
returns void language plpgsql volatile security definer set search_path = public
as $$
begin
  perform public._session_admin(session_token);
  update public.sites s
     set site_type_id = coalesce(admin_update_site.site_type_id, s.site_type_id),
         is_active = coalesce(admin_update_site.is_active, s.is_active)
   where s.id = admin_update_site.id;
  if not found then raise exception 'site not found' using errcode = 'P0002'; end if;
end;
$$;

-- site_types
create or replace function public.admin_list_site_types(session_token text)
returns setof public.site_types language plpgsql stable security definer set search_path = public
as $$
begin
  perform public._session_admin(session_token);
  return query select * from public.site_types order by is_active desc, label;
end;
$$;

create or replace function public.admin_add_site_type(session_token text, label text)
returns void language plpgsql volatile security definer set search_path = public
as $$
begin
  perform public._session_admin(session_token);
  if coalesce(btrim(label), '') = '' then raise exception 'label required' using errcode = '22023'; end if;
  insert into public.site_types (label) values (btrim(admin_add_site_type.label));
end;
$$;

create or replace function public.admin_update_site_type(session_token text, id uuid, label text, is_active boolean)
returns void language plpgsql volatile security definer set search_path = public
as $$
begin
  perform public._session_admin(session_token);
  update public.site_types st
     set label = coalesce(nullif(btrim(admin_update_site_type.label), ''), st.label),
         is_active = coalesce(admin_update_site_type.is_active, st.is_active)
   where st.id = admin_update_site_type.id;
  if not found then raise exception 'site type not found' using errcode = 'P0002'; end if;
end;
$$;

-- site_entry_points
create or replace function public.admin_list_site_entry_points(session_token text)
returns setof public.site_entry_points language plpgsql stable security definer set search_path = public
as $$
begin
  perform public._session_admin(session_token);
  return query select * from public.site_entry_points order by site_id, is_active desc, label;
end;
$$;

create or replace function public.admin_add_site_entry_point(session_token text, site_id text, label text)
returns void language plpgsql volatile security definer set search_path = public
as $$
begin
  perform public._session_admin(session_token);
  if coalesce(btrim(label), '') = '' then raise exception 'label required' using errcode = '22023'; end if;
  if coalesce(btrim(admin_add_site_entry_point.site_id), '') = '' then raise exception 'site required' using errcode = '22023'; end if;
  insert into public.site_entry_points (site_id, label) values (admin_add_site_entry_point.site_id, btrim(admin_add_site_entry_point.label));
end;
$$;

create or replace function public.admin_update_site_entry_point(session_token text, id uuid, label text, is_active boolean)
returns void language plpgsql volatile security definer set search_path = public
as $$
begin
  perform public._session_admin(session_token);
  update public.site_entry_points ep
     set label = coalesce(nullif(btrim(admin_update_site_entry_point.label), ''), ep.label),
         is_active = coalesce(admin_update_site_entry_point.is_active, ep.is_active)
   where ep.id = admin_update_site_entry_point.id;
  if not found then raise exception 'entry point not found' using errcode = 'P0002'; end if;
end;
$$;

-- ============================================================================
-- Delete RPCs: new entities + refreshed snapshots (extends 0013).
-- ============================================================================
create or replace function public.admin_delete_site_type(session_token text, actor_pin text, id uuid, reason text)
returns void language plpgsql volatile security definer set search_path = public, extensions
as $$
declare v_admin uuid; v_row public.site_types;
begin
  v_admin := public._session_admin(session_token);
  perform public._assert_step_up(v_admin, actor_pin);
  if coalesce(btrim(reason), '') = '' then raise exception 'reason required' using errcode = '22023'; end if;
  select * into v_row from public.site_types st where st.id = admin_delete_site_type.id;
  if not found then raise exception 'site type not found' using errcode = 'P0002'; end if;
  perform public._log_deletion('site_type', v_row.id::text, to_jsonb(v_row), v_admin, reason);
  begin
    delete from public.site_types st where st.id = admin_delete_site_type.id;
  exception when foreign_key_violation then
    raise exception 'referenced by history — archive instead' using errcode = '23503';
  end;
end;
$$;

create or replace function public.admin_delete_site_entry_point(session_token text, actor_pin text, id uuid, reason text)
returns void language plpgsql volatile security definer set search_path = public, extensions
as $$
declare v_admin uuid; v_row public.site_entry_points;
begin
  v_admin := public._session_admin(session_token);
  perform public._assert_step_up(v_admin, actor_pin);
  if coalesce(btrim(reason), '') = '' then raise exception 'reason required' using errcode = '22023'; end if;
  select * into v_row from public.site_entry_points ep where ep.id = admin_delete_site_entry_point.id;
  if not found then raise exception 'entry point not found' using errcode = 'P0002'; end if;
  perform public._log_deletion('site_entry_point', v_row.id::text, to_jsonb(v_row), v_admin, reason);
  begin
    delete from public.site_entry_points ep where ep.id = admin_delete_site_entry_point.id;
  exception when foreign_key_violation then
    raise exception 'referenced by history — archive instead' using errcode = '23503';
  end;
end;
$$;

-- refreshed snapshots (trip children / duty workers cascade on delete)
create or replace function public.admin_delete_trip(session_token text, actor_pin text, trip_id uuid, reason text)
returns void language plpgsql volatile security definer set search_path = public, extensions
as $$
declare v_admin uuid; v_trip public.trips; v_snap jsonb;
begin
  v_admin := public._session_admin(session_token);
  perform public._assert_step_up(v_admin, actor_pin);
  if coalesce(btrim(reason), '') = '' then raise exception 'reason required' using errcode = '22023'; end if;
  select * into v_trip from public.trips where id = trip_id;
  if not found then raise exception 'trip not found' using errcode = 'P0002'; end if;
  v_snap := public._trip_json(v_trip);
  perform public._log_deletion('trip', v_trip.id::text, v_snap, v_admin, reason);
  delete from public.trips where id = trip_id;  -- cascades items/workers/vehicles/segments
end;
$$;

create or replace function public.admin_delete_duty_shift(session_token text, actor_pin text, duty_shift_id uuid, reason text)
returns void language plpgsql volatile security definer set search_path = public, extensions
as $$
declare v_admin uuid; v_row public.duty_shifts; v_snap jsonb;
begin
  v_admin := public._session_admin(session_token);
  perform public._assert_step_up(v_admin, actor_pin);
  if coalesce(btrim(reason), '') = '' then raise exception 'reason required' using errcode = '22023'; end if;
  select * into v_row from public.duty_shifts where id = duty_shift_id;
  if not found then raise exception 'shift not found' using errcode = 'P0002'; end if;
  v_snap := public._duty_json(v_row);
  perform public._log_deletion('duty_shift', v_row.id::text, v_snap, v_admin, reason);
  delete from public.duty_shifts where id = duty_shift_id;  -- cascades duty_shift_workers
end;
$$;

-- ============================================================================
-- Analytics: per-worker credit + route/vehicle from arrays. Keep excluded filter.
-- ============================================================================
create or replace function public.admin_asset_summary(session_token text, asset_id text, from_date date, to_date date)
returns jsonb language plpgsql stable security definer set search_path = public
as $$
declare v_json jsonb;
begin
  perform public._session_admin(session_token);
  with filt as (
    select distinct tr.*, coalesce(tr.started_at, tr.created_at) as dep
    from public.trips tr join public.trip_items ti on ti.trip_id = tr.id
    where ti.asset_id = admin_asset_summary.asset_id and tr.status = 'completed'
      and tr.excluded_from_analysis = false
      and coalesce((tr.actual->>'completed_at')::timestamptz, tr.created_at)::date
          between admin_asset_summary.from_date and admin_asset_summary.to_date
  ),
  veh as (  -- per trip: actual vehicles, else planned
    select f.id, coalesce(
      nullif(f.actual->'vehicles', '[]'::jsonb),
      (select coalesce(jsonb_agg(tv.vehicle_id order by tv.vehicle_id), '[]'::jsonb)
         from public.trip_vehicles tv where tv.trip_id = f.id)) arr
    from filt f
  ),
  veh_rows as (select id, jsonb_array_elements_text(arr) k from veh where jsonb_typeof(arr) = 'array' and jsonb_array_length(arr) > 0),
  rte as (  -- per trip: actual route legs, else planned
    select f.id, coalesce(
      nullif((select jsonb_agg(e.value->>'route_id') from jsonb_array_elements(f.actual->'segments') e), '[]'::jsonb),
      (select coalesce(jsonb_agg(s.route_id order by s.sequence), '[]'::jsonb)
         from public.trip_route_segments s where s.trip_id = f.id)) arr
    from filt f
  ),
  rte_rows as (select id, jsonb_array_elements_text(arr) k from rte where jsonb_typeof(arr) = 'array' and jsonb_array_length(arr) > 0)
  select jsonb_build_object(
    'total',    (select count(*) from filt),
    'deviated', (select count(*) from filt where coalesce((actual->>'deviated')::boolean, false)),
    'hours', coalesce((select jsonb_agg(jsonb_build_object('hour', h, 'count', c) order by h)
                       from (select extract(hour from dep)::int h, count(*) c from filt group by 1) x), '[]'::jsonb),
    'by_vehicle', coalesce((select jsonb_agg(jsonb_build_object('key', k, 'count', c) order by c desc)
                       from (select k, count(distinct id) c from veh_rows group by k) x), '[]'::jsonb),
    'by_route', coalesce((select jsonb_agg(jsonb_build_object('key', k, 'count', c) order by c desc)
                       from (select k, count(distinct id) c from rte_rows group by k) x), '[]'::jsonb),
    'by_worker', coalesce((select jsonb_agg(jsonb_build_object('key', nm, 'count', c) order by c desc)
                       from (select e.name nm, count(distinct f.id) c
                             from filt f join public.trip_workers tw on tw.trip_id = f.id
                                          join public.employees e on e.id = tw.employee_id
                             group by e.name) x), '[]'::jsonb)
  ) into v_json;
  return v_json;
end;
$$;

create or replace function public.admin_duty_summary(session_token text, site_id text, from_date date, to_date date)
returns jsonb language plpgsql stable security definer set search_path = public
as $$
declare v_out jsonb;
begin
  perform public._session_admin(session_token);
  with filt as (
    select ds.* from public.duty_shifts ds
    where ds.site_id = admin_duty_summary.site_id and ds.status = 'completed'
      and ds.excluded_from_analysis = false
      and coalesce((ds.actual->>'actual_end')::timestamptz, ds.end_time)::date
          between admin_duty_summary.from_date and admin_duty_summary.to_date
  )
  select jsonb_build_object(
    'total', (select count(*) from filt),
    'anomalies', (select count(*) from filt where coalesce((actual->>'anomaly_found')::boolean, false)),
    'by_type', coalesce((select jsonb_agg(jsonb_build_object('key', k, 'count', c) order by c desc)
                 from (select dt.label k, count(*) c from filt f join public.duty_types dt on dt.id = f.duty_type_id group by dt.label) x), '[]'::jsonb),
    'by_worker', coalesce((select jsonb_agg(jsonb_build_object('key', nm, 'count', c) order by c desc)
                 from (select e.name nm, count(distinct f.id) c
                       from filt f join public.duty_shift_workers w on w.duty_shift_id = f.id
                                    join public.employees e on e.id = w.employee_id
                       group by e.name) x), '[]'::jsonb)
  ) into v_out;
  return v_out;
end;
$$;

-- ============================================================================
-- Privileges
-- ============================================================================
grant execute on function public.create_trip(text, text, text, uuid[], text[], jsonb, uuid, text, text[], uuid) to anon, authenticated;
grant execute on function public.update_trip_item_checklist(text, uuid, jsonb, text)   to anon, authenticated;
grant execute on function public.start_trip(text, uuid)                                to anon, authenticated;
grant execute on function public.complete_trip(text, uuid, jsonb)                      to anon, authenticated;
grant execute on function public.list_my_trips(text)                                   to anon, authenticated;
grant execute on function public.list_all_trips(text)                                  to anon, authenticated;
grant execute on function public.list_trip_history(text)                               to anon, authenticated;
grant execute on function public.create_duty_shift(text, text, uuid[], uuid, timestamptz, timestamptz) to anon, authenticated;
grant execute on function public.update_duty_checklist(text, uuid, jsonb, text)        to anon, authenticated;
grant execute on function public.start_duty(text, uuid)                                to anon, authenticated;
grant execute on function public.complete_duty(text, uuid, jsonb)                      to anon, authenticated;
grant execute on function public.list_my_duties(text)                                  to anon, authenticated;
grant execute on function public.list_all_duties(text)                                 to anon, authenticated;
grant execute on function public.list_duty_history(text)                               to anon, authenticated;
grant execute on function public.admin_list_sites(text)                                to anon, authenticated;
grant execute on function public.admin_add_site(text, text, uuid)                      to anon, authenticated;
grant execute on function public.admin_update_site(text, text, uuid, boolean)          to anon, authenticated;
grant execute on function public.admin_list_site_types(text)                           to anon, authenticated;
grant execute on function public.admin_add_site_type(text, text)                       to anon, authenticated;
grant execute on function public.admin_update_site_type(text, uuid, text, boolean)     to anon, authenticated;
grant execute on function public.admin_list_site_entry_points(text)                    to anon, authenticated;
grant execute on function public.admin_add_site_entry_point(text, text, text)          to anon, authenticated;
grant execute on function public.admin_update_site_entry_point(text, uuid, text, boolean) to anon, authenticated;
grant execute on function public.admin_delete_site_type(text, text, uuid, text)        to anon, authenticated;
grant execute on function public.admin_delete_site_entry_point(text, text, uuid, text)  to anon, authenticated;
grant execute on function public.admin_asset_summary(text, text, date, date)           to anon, authenticated;
grant execute on function public.admin_duty_summary(text, text, date, date)            to anon, authenticated;

-- ----------------------------------------------------------------------------
-- Verify (with valid tokens):
--   select public.create_trip('<admin>','S01','S07', array['<w-uuid>']::uuid[], array['V-1'],
--     '[{"sequence":1,"route_id":"Blue","checkpoint_note":"פנייה ימינה"},{"sequence":2,"route_id":"Green"}]'::jsonb,
--     null, '08:00', array['A1','A2'], null);
--   select * from public.admin_list_site_types('<admin>');
--   select public.admin_asset_summary('<admin>','A1', current_date-30, current_date);
-- ----------------------------------------------------------------------------
