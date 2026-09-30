-- =============================================================================
-- OPS Dashboard — 0015: real scheduling + actual timestamps.
--   * trips.time_window (free text) -> scheduled_date (date, REQUIRED) +
--     planned_start_time / planned_end_time (time, optional guidance only).
--   * trips.started_at -> actual_started_at; add actual_completed_at. Both are
--     stamped by the system (now()) inside start_trip / complete_trip — never
--     entered by a user. These are the true click times.
--   * All time/date analytics now key off actual_started_at (what happened),
--     not the plan and not created_at.
--
-- Depends on 0014. Data is backfilled before columns are dropped / made NOT NULL.
-- Safe to re-run (idempotent).
-- =============================================================================

set search_path = public, extensions;

-- ============================================================================
-- Schema: new scheduling + actual-time columns.
-- ============================================================================
alter table public.trips add column if not exists scheduled_date      date;
alter table public.trips add column if not exists planned_start_time  time;
alter table public.trips add column if not exists planned_end_time    time;
alter table public.trips add column if not exists actual_started_at   timestamptz;
alter table public.trips add column if not exists actual_completed_at timestamptz;

-- Backfill from existing data BEFORE tightening / dropping columns.
do $$
begin
  -- actual times from the old started_at column + actual.completed_at
  if exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='trips' and column_name='started_at') then
    update public.trips set actual_started_at = started_at
      where actual_started_at is null and started_at is not null;
  end if;
  update public.trips
     set actual_completed_at = (actual->>'completed_at')::timestamptz
   where actual_completed_at is null and nullif(actual->>'completed_at', '') is not null;

  -- scheduled_date: prefer the real start day, else creation day
  update public.trips
     set scheduled_date = coalesce(actual_started_at, created_at)::date
   where scheduled_date is null;
end $$;

alter table public.trips alter column scheduled_date set not null;

-- Drop the retired columns (free-text window + the now-renamed started_at).
alter table public.trips drop column if exists time_window;
alter table public.trips drop column if exists started_at;

-- ============================================================================
-- create_trip: scheduled_date (+ optional planned times) replace time_window.
-- Signature changes -> drop the 0014 version first.
-- ============================================================================
drop function if exists public.create_trip(text, text, text, uuid[], text[], jsonb, uuid, text, text[], uuid);

create function public.create_trip(
  session_token      text,
  from_site_id       text,
  to_site_id         text,
  worker_ids         uuid[],
  vehicle_ids        text[],
  route_segments     jsonb,
  entry_point_id     uuid,
  scheduled_date     date,
  planned_start_time time,
  planned_end_time   time,
  asset_ids          text[],
  return_of_trip_id  uuid
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
  if create_trip.scheduled_date is null then
    raise exception 'scheduled date required' using errcode = '22023';
  end if;

  insert into public.trips (from_site_id, to_site_id, scheduled_date, planned_start_time, planned_end_time,
                            status, return_of_trip_id, planned_entry_point_id, audit_log)
  values (create_trip.from_site_id, create_trip.to_site_id, create_trip.scheduled_date,
          create_trip.planned_start_time, create_trip.planned_end_time,
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

-- ============================================================================
-- start_trip / complete_trip now stamp the true click times.
-- ============================================================================
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
     set status = 'active', actual_started_at = now(),
         audit_log = v_trip.audit_log || jsonb_build_array(to_char(now(), 'HH24:MI') || ' – Trip started')
   where id = start_trip.trip_id;
  return (select public._trip_json(t) from public.trips t where t.id = start_trip.trip_id);
end;
$$;

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

  select array_agg(s.route_id order by s.sequence) into v_planned_routes
    from public.trip_route_segments s where s.trip_id = complete_trip.trip_id;
  select array_agg(x.rid order by x.ord) into v_actual_routes
    from (select (e.value->>'route_id') rid, e.ordinality ord
          from jsonb_array_elements(coalesce(p_actual->'segments', '[]'::jsonb)) with ordinality as e(value, ordinality)
          where nullif(btrim(e.value->>'route_id'), '') is not null) x;

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
     set status = 'completed', actual = v_actual, actual_completed_at = now(),
         audit_log = v_trip.audit_log || jsonb_build_array(
           to_char(now(), 'HH24:MI') || case when v_dev then ' – Trip completed (deviation logged)' else ' – Trip completed' end)
   where id = complete_trip.trip_id;
  return (select public._trip_json(t) from public.trips t where t.id = complete_trip.trip_id);
end;
$$;

-- ============================================================================
-- Analytics keyed on actual_started_at (what happened), keep excluded filter.
-- ============================================================================
create or replace function public.admin_asset_summary(session_token text, asset_id text, from_date date, to_date date)
returns jsonb language plpgsql stable security definer set search_path = public
as $$
declare v_json jsonb;
begin
  perform public._session_admin(session_token);
  with filt as (
    select distinct tr.*, coalesce(tr.actual_started_at, tr.created_at) as dep
    from public.trips tr join public.trip_items ti on ti.trip_id = tr.id
    where ti.asset_id = admin_asset_summary.asset_id and tr.status = 'completed'
      and tr.excluded_from_analysis = false
      and coalesce(tr.actual_started_at, tr.created_at)::date
          between admin_asset_summary.from_date and admin_asset_summary.to_date
  ),
  veh as (
    select f.id, coalesce(
      nullif(f.actual->'vehicles', '[]'::jsonb),
      (select coalesce(jsonb_agg(tv.vehicle_id order by tv.vehicle_id), '[]'::jsonb)
         from public.trip_vehicles tv where tv.trip_id = f.id)) arr
    from filt f
  ),
  veh_rows as (select id, jsonb_array_elements_text(arr) k from veh where jsonb_typeof(arr) = 'array' and jsonb_array_length(arr) > 0),
  rte as (
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

create or replace function public.admin_joint_movement_summary(session_token text, from_date date, to_date date)
returns jsonb language plpgsql stable security definer set search_path = public
as $$
declare v_out jsonb;
begin
  perform public._session_admin(session_token);
  with tf as (
    select tr.id from public.trips tr
    where tr.status = 'completed' and tr.excluded_from_analysis = false
      and coalesce(tr.actual_started_at, tr.created_at)::date
          between admin_joint_movement_summary.from_date and admin_joint_movement_summary.to_date
  ),
  ti as (select ti.trip_id, ti.asset_id from public.trip_items ti where ti.trip_id in (select id from tf)),
  totals as (select asset_id, count(distinct trip_id) c from ti group by asset_id),
  pairs as (
    select a.asset_id a_id, b.asset_id b_id, count(distinct a.trip_id) joint
    from ti a join ti b on a.trip_id = b.trip_id and a.asset_id < b.asset_id
    group by a.asset_id, b.asset_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'a', p.a_id, 'b', p.b_id, 'joint', p.joint, 'total_a', ta.c, 'total_b', tb.c,
    'pct_a', round(100.0 * p.joint / nullif(ta.c, 0)), 'pct_b', round(100.0 * p.joint / nullif(tb.c, 0))
  ) order by p.joint desc), '[]'::jsonb) into v_out
  from pairs p join totals ta on ta.asset_id = p.a_id join totals tb on tb.asset_id = p.b_id;
  return v_out;
end;
$$;

-- ============================================================================
-- Privileges (only the re-created create_trip needs a fresh grant).
-- ============================================================================
grant execute on function public.create_trip(text, text, text, uuid[], text[], jsonb, uuid, date, time, time, text[], uuid) to anon, authenticated;

-- ----------------------------------------------------------------------------
-- Verify (with valid tokens):
--   select public.create_trip('<admin>','S01','S07', array['<w-uuid>']::uuid[], array['V-1'],
--     '[{"sequence":1,"route_id":"Blue"}]'::jsonb, null, current_date, '08:00', '09:30',
--     array['A1'], null);
--   select public.admin_asset_summary('<admin>','A1', current_date-30, current_date);
-- ----------------------------------------------------------------------------
