-- =============================================================================
-- OPS Dashboard — 0020: the auto-generation engine (pure randomness from
-- predefined pools; no history weighting yet — that's a future Learning Mode).
--
--   * Worker flexibility: any ACTIVE employee can Start/Complete/update any task
--     (admin always). Complete records actual_worker_id; if the real performer
--     wasn't planned, a reason is required (same principle as vehicle/route
--     deviation). list_my_trips / list_my_duties now show ALL open tasks.
--   * Eligibility pools (empty = everyone/everything active):
--     asset_eligible_workers / asset_eligible_vehicles / duty_slot_eligible_workers.
--   * route_templates (+ segments) and asset_eligible_route_templates (mandatory
--     per asset for generation).
--   * duty_slot_definitions (fixed recurring shifts) + eligible workers.
--   * asset_weekdays (which days each asset runs; seeded Mon–Fri = 1..5).
--   * assets.gen_worker_count / gen_vehicle_count and duty slot worker_count:
--     how many to pick at random per task (admin-set, default 1).
--   * admin_generate_week(week_start_date): one click → a whole planned week.
--     Re-runnable: skips an asset/slot that already has a task that day.
--     Destination = the active site of type 'מפעל'. Origin = asset home site.
--
-- Depends on 0010–0019. Safe to re-run (idempotent).
-- =============================================================================

set search_path = public, extensions;

-- ============================================================================
-- Schema: eligibility pools, route templates, duty slots, weekdays, counts
-- ============================================================================
create table if not exists public.asset_eligible_workers (
  asset_id text not null references public.assets(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  primary key (asset_id, employee_id)
);
alter table public.asset_eligible_workers enable row level security;

create table if not exists public.asset_eligible_vehicles (
  asset_id text not null references public.assets(id) on delete cascade,
  vehicle_id text not null references public.vehicles(id) on delete cascade,
  primary key (asset_id, vehicle_id)
);
alter table public.asset_eligible_vehicles enable row level security;

create table if not exists public.route_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  entry_point_id uuid references public.site_entry_points(id),
  is_active boolean not null default true
);
alter table public.route_templates enable row level security;

create table if not exists public.route_template_segments (
  id uuid primary key default gen_random_uuid(),
  route_template_id uuid not null references public.route_templates(id) on delete cascade,
  sequence integer not null,
  route_id text references public.routes(id),
  checkpoint_note text
);
create index if not exists idx_rts_tpl on public.route_template_segments (route_template_id, sequence);
alter table public.route_template_segments enable row level security;

create table if not exists public.asset_eligible_route_templates (
  asset_id text not null references public.assets(id) on delete cascade,
  route_template_id uuid not null references public.route_templates(id) on delete cascade,
  primary key (asset_id, route_template_id)
);
alter table public.asset_eligible_route_templates enable row level security;

create table if not exists public.duty_slot_definitions (
  id uuid primary key default gen_random_uuid(),
  site_id text not null references public.sites(id),
  duty_type_id uuid not null references public.duty_types(id),
  label text,
  start_time time not null,
  end_time time not null,
  weekdays int[] not null default '{0,1,2,3,4,5,6}',
  worker_count int not null default 1,
  is_active boolean not null default true
);
alter table public.duty_slot_definitions enable row level security;

create table if not exists public.duty_slot_eligible_workers (
  duty_slot_id uuid not null references public.duty_slot_definitions(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  primary key (duty_slot_id, employee_id)
);
alter table public.duty_slot_eligible_workers enable row level security;

create table if not exists public.asset_weekdays (
  asset_id text not null references public.assets(id) on delete cascade,
  weekday int not null check (weekday between 0 and 6),
  primary key (asset_id, weekday)
);
alter table public.asset_weekdays enable row level security;

alter table public.assets add column if not exists gen_worker_count  int not null default 1;
alter table public.assets add column if not exists gen_vehicle_count int not null default 1;
alter table public.duty_shifts add column if not exists slot_id uuid references public.duty_slot_definitions(id) on delete set null;

-- seed: every existing asset runs Mon–Fri (1..5), once
insert into public.asset_weekdays (asset_id, weekday)
select a.id, wd from public.assets a cross join unnest(array[1,2,3,4,5]) wd
where not exists (select 1 from public.asset_weekdays x where x.asset_id = a.id)
on conflict do nothing;

-- ============================================================================
-- Worker flexibility: any active employee may act; complete records the real
-- performer and requires a reason when they weren't planned.
-- ============================================================================
create or replace function public.update_trip_item_checklist(session_token text, trip_item_id uuid, p_checklist jsonb, p_note text)
returns void language plpgsql volatile security definer set search_path = public
as $$
declare v_item public.trip_items; v_trip public.trips;
begin
  perform public._session_employee(session_token);  -- any active employee
  select * into v_item from public.trip_items where id = trip_item_id;
  if not found then raise exception 'item not found' using errcode = 'P0002'; end if;
  select * into v_trip from public.trips where id = v_item.trip_id;
  if v_trip.status <> 'planned' then raise exception 'trip is not editable' using errcode = '22023'; end if;
  update public.trip_items set checklist = p_checklist, checklist_note = p_note where id = trip_item_id;
end;
$$;

create or replace function public.start_trip(session_token text, trip_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = public
as $$
declare v_trip public.trips; v_bad integer;
begin
  perform public._session_employee(session_token);  -- any active employee
  select * into v_trip from public.trips where id = trip_id;
  if not found then raise exception 'trip not found' using errcode = 'P0002'; end if;
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
  v_actor uuid; v_trip public.trips; v_dev boolean; v_actual jsonb;
  v_planned_routes text[]; v_actual_routes text[];
  v_planned_vehicles text[]; v_actual_vehicles text[];
  v_planned_entry text; v_actual_entry text;
  v_awid uuid; v_worker_dev boolean;
begin
  v_actor := public._session_employee(session_token);
  select * into v_trip from public.trips where id = trip_id;
  if not found then raise exception 'trip not found' using errcode = 'P0002'; end if;
  if v_trip.status <> 'active' then raise exception 'trip is not active' using errcode = '22023'; end if;

  -- the real performer: supplied, else the logged-in user
  v_awid := coalesce(nullif(btrim(p_actual->>'actual_worker_id'), '')::uuid, v_actor);
  v_worker_dev := not exists (select 1 from public.trip_workers tw where tw.trip_id = complete_trip.trip_id and tw.employee_id = v_awid);

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
        or (v_planned_entry is distinct from v_actual_entry)
        or v_worker_dev;

  if v_dev and coalesce(btrim(p_actual->>'reason'), '') = '' then
    raise exception 'deviation reason required' using errcode = '22023';
  end if;

  v_actual := jsonb_build_object(
    'segments',        coalesce(p_actual->'segments', '[]'::jsonb),
    'entry_point_id',  v_actual_entry,
    'vehicles',        coalesce(p_actual->'vehicles', '[]'::jsonb),
    'actual_worker_id', v_awid,
    'completed_at',    now(),
    'deviated',        v_dev,
    'reason',          case when v_dev then btrim(p_actual->>'reason') else '' end
  );
  update public.trips
     set status = 'completed', actual = v_actual, actual_completed_at = now(),
         audit_log = v_trip.audit_log || jsonb_build_array(
           to_char(now(), 'HH24:MI') || case when v_dev then ' – Trip completed (deviation logged)' else ' – Trip completed' end)
   where id = complete_trip.trip_id;
  return (select public._trip_json(t) from public.trips t where t.id = complete_trip.trip_id);
end;
$$;

create or replace function public.update_duty_checklist(session_token text, duty_shift_id uuid, p_checklist jsonb, p_note text)
returns void language plpgsql volatile security definer set search_path = public
as $$
declare v_shift public.duty_shifts;
begin
  perform public._session_employee(session_token);
  select * into v_shift from public.duty_shifts where id = duty_shift_id;
  if not found then raise exception 'shift not found' using errcode = 'P0002'; end if;
  if v_shift.status <> 'planned' then raise exception 'shift is not editable' using errcode = '22023'; end if;
  update public.duty_shifts set checklist = p_checklist, checklist_note = p_note where id = duty_shift_id;
end;
$$;

create or replace function public.start_duty(session_token text, duty_shift_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = public
as $$
declare v_shift public.duty_shifts; v_unchecked boolean;
begin
  perform public._session_employee(session_token);
  select * into v_shift from public.duty_shifts where id = duty_shift_id;
  if not found then raise exception 'shift not found' using errcode = 'P0002'; end if;
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
declare v_actor uuid; v_shift public.duty_shifts; v_anom boolean; v_actual jsonb; v_awid uuid; v_worker_dev boolean; v_dev boolean;
begin
  v_actor := public._session_employee(session_token);
  select * into v_shift from public.duty_shifts where id = duty_shift_id;
  if not found then raise exception 'shift not found' using errcode = 'P0002'; end if;
  if v_shift.status <> 'active' then raise exception 'shift is not active' using errcode = '22023'; end if;

  v_awid := coalesce(nullif(btrim(p_actual->>'actual_worker_id'), '')::uuid, v_actor);
  v_worker_dev := not exists (select 1 from public.duty_shift_workers w where w.duty_shift_id = complete_duty.duty_shift_id and w.employee_id = v_awid);
  v_anom := coalesce((p_actual->>'anomaly_found')::boolean, false);

  if v_anom and coalesce(btrim(p_actual->>'anomaly_notes'), '') = '' then
    raise exception 'anomaly notes required' using errcode = '22023';
  end if;
  if v_worker_dev and coalesce(btrim(p_actual->>'reason'), '') = '' then
    raise exception 'deviation reason required' using errcode = '22023';
  end if;
  v_dev := v_worker_dev;

  v_actual := jsonb_build_object(
    'actual_start',   nullif(btrim(p_actual->>'actual_start'), ''),
    'actual_end',     nullif(btrim(p_actual->>'actual_end'), ''),
    'anomaly_found',  v_anom,
    'anomaly_notes',  case when v_anom then btrim(p_actual->>'anomaly_notes') else '' end,
    'actual_worker_id', v_awid,
    'deviated',       v_dev,
    'reason',         case when v_dev then btrim(p_actual->>'reason') else '' end,
    'completed_at',   now()
  );
  update public.duty_shifts set status = 'completed', actual = v_actual,
    audit_log = v_shift.audit_log || jsonb_build_array(to_char(now(), 'HH24:MI') ||
      case when v_anom then ' – Shift completed (anomaly logged)' else ' – Shift completed' end)
   where id = duty_shift_id;
  return (select public._duty_json(d) from public.duty_shifts d where d.id = duty_shift_id);
end;
$$;

-- lists now show ALL open tasks to any active employee (pickup/cover)
create or replace function public.list_my_trips(session_token text)
returns jsonb language plpgsql stable security definer set search_path = public
as $$
begin
  perform public._session_employee(session_token);
  return (select coalesce(jsonb_agg(public._trip_json(tr) order by tr.created_at desc), '[]'::jsonb)
          from public.trips tr where tr.status <> 'completed');
end;
$$;

create or replace function public.list_my_duties(session_token text)
returns jsonb language plpgsql stable security definer set search_path = public
as $$
begin
  perform public._session_employee(session_token);
  return (select coalesce(jsonb_agg(public._duty_json(ds) order by ds.created_at desc), '[]'::jsonb)
          from public.duty_shifts ds where ds.status <> 'completed');
end;
$$;

-- ============================================================================
-- Per-asset generation config (read + setters)
-- ============================================================================
create or replace function public.admin_list_asset_gen(session_token text)
returns table (id text, gen_worker_count int, gen_vehicle_count int, weekdays int[],
               eligible_worker_ids uuid[], eligible_vehicle_ids text[], route_template_ids uuid[])
language plpgsql stable security definer set search_path = public
as $$
begin
  perform public._session_admin(session_token);
  return query
    select a.id, a.gen_worker_count, a.gen_vehicle_count,
      coalesce((select array_agg(w.weekday order by w.weekday) from public.asset_weekdays w where w.asset_id = a.id), '{}'),
      coalesce((select array_agg(x.employee_id) from public.asset_eligible_workers x where x.asset_id = a.id), '{}'),
      coalesce((select array_agg(x.vehicle_id order by x.vehicle_id) from public.asset_eligible_vehicles x where x.asset_id = a.id), '{}'),
      coalesce((select array_agg(x.route_template_id) from public.asset_eligible_route_templates x where x.asset_id = a.id), '{}')
    from public.assets a order by a.id;
end;
$$;

create or replace function public.admin_set_asset_gen_counts(session_token text, asset_id text, worker_count int, vehicle_count int)
returns void language plpgsql volatile security definer set search_path = public
as $$
begin
  perform public._session_admin(session_token);
  update public.assets a set gen_worker_count = greatest(1, coalesce(worker_count, 1)),
                             gen_vehicle_count = greatest(0, coalesce(vehicle_count, 1))
   where a.id = admin_set_asset_gen_counts.asset_id;
  if not found then raise exception 'asset not found' using errcode = 'P0002'; end if;
end;
$$;

create or replace function public.admin_set_asset_weekdays(session_token text, asset_id text, weekdays int[])
returns void language plpgsql volatile security definer set search_path = public
as $$
declare v_d int;
begin
  perform public._session_admin(session_token);
  delete from public.asset_weekdays w where w.asset_id = admin_set_asset_weekdays.asset_id;
  if weekdays is not null then
    foreach v_d in array weekdays loop
      if v_d between 0 and 6 then
        insert into public.asset_weekdays (asset_id, weekday) values (admin_set_asset_weekdays.asset_id, v_d) on conflict do nothing;
      end if;
    end loop;
  end if;
end;
$$;

create or replace function public.admin_set_asset_eligible_workers(session_token text, asset_id text, employee_ids uuid[])
returns void language plpgsql volatile security definer set search_path = public
as $$
declare v_e uuid;
begin
  perform public._session_admin(session_token);
  delete from public.asset_eligible_workers x where x.asset_id = admin_set_asset_eligible_workers.asset_id;
  if employee_ids is not null then
    foreach v_e in array employee_ids loop
      insert into public.asset_eligible_workers (asset_id, employee_id) values (admin_set_asset_eligible_workers.asset_id, v_e) on conflict do nothing;
    end loop;
  end if;
end;
$$;

create or replace function public.admin_set_asset_eligible_vehicles(session_token text, asset_id text, vehicle_ids text[])
returns void language plpgsql volatile security definer set search_path = public
as $$
declare v_v text;
begin
  perform public._session_admin(session_token);
  delete from public.asset_eligible_vehicles x where x.asset_id = admin_set_asset_eligible_vehicles.asset_id;
  if vehicle_ids is not null then
    foreach v_v in array vehicle_ids loop
      insert into public.asset_eligible_vehicles (asset_id, vehicle_id) values (admin_set_asset_eligible_vehicles.asset_id, v_v) on conflict do nothing;
    end loop;
  end if;
end;
$$;

create or replace function public.admin_set_asset_route_templates(session_token text, asset_id text, template_ids uuid[])
returns void language plpgsql volatile security definer set search_path = public
as $$
declare v_t uuid;
begin
  perform public._session_admin(session_token);
  delete from public.asset_eligible_route_templates x where x.asset_id = admin_set_asset_route_templates.asset_id;
  if template_ids is not null then
    foreach v_t in array template_ids loop
      insert into public.asset_eligible_route_templates (asset_id, route_template_id) values (admin_set_asset_route_templates.asset_id, v_t) on conflict do nothing;
    end loop;
  end if;
end;
$$;

-- ============================================================================
-- Route templates (reusable route leg sets)
-- ============================================================================
create or replace function public.admin_list_route_templates(session_token text)
returns jsonb language plpgsql stable security definer set search_path = public
as $$
declare v_out jsonb;
begin
  perform public._session_admin(session_token);
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', rt.id, 'name', rt.name, 'entry_point_id', rt.entry_point_id, 'is_active', rt.is_active,
    'segments', coalesce((select jsonb_agg(jsonb_build_object('sequence', s.sequence, 'route_id', s.route_id, 'checkpoint_note', s.checkpoint_note) order by s.sequence)
                          from public.route_template_segments s where s.route_template_id = rt.id), '[]'::jsonb)
  ) order by rt.is_active desc, rt.name), '[]'::jsonb) into v_out from public.route_templates rt;
  return v_out;
end;
$$;

-- upsert a template with its segments in one call (id null = create)
create or replace function public.admin_save_route_template(session_token text, id uuid, name text, entry_point_id uuid, is_active boolean, segments jsonb)
returns uuid language plpgsql volatile security definer set search_path = public
as $$
declare v_id uuid; v_seg jsonb; v_i int := 0;
begin
  perform public._session_admin(session_token);
  if coalesce(btrim(name), '') = '' then raise exception 'name required' using errcode = '22023'; end if;
  if admin_save_route_template.id is null then
    insert into public.route_templates (name, entry_point_id, is_active)
    values (btrim(name), entry_point_id, coalesce(is_active, true)) returning route_templates.id into v_id;
  else
    v_id := admin_save_route_template.id;
    update public.route_templates rt set name = btrim(admin_save_route_template.name),
      entry_point_id = admin_save_route_template.entry_point_id, is_active = coalesce(admin_save_route_template.is_active, rt.is_active)
     where rt.id = v_id;
    if not found then raise exception 'template not found' using errcode = 'P0002'; end if;
  end if;
  delete from public.route_template_segments s where s.route_template_id = v_id;
  if segments is not null and jsonb_typeof(segments) = 'array' then
    for v_seg in select value from jsonb_array_elements(segments) loop
      if nullif(btrim(v_seg->>'route_id'), '') is not null then
        v_i := v_i + 1;
        insert into public.route_template_segments (route_template_id, sequence, route_id, checkpoint_note)
        values (v_id, coalesce((v_seg->>'sequence')::int, v_i), btrim(v_seg->>'route_id'), nullif(btrim(v_seg->>'checkpoint_note'), ''));
      end if;
    end loop;
  end if;
  return v_id;
end;
$$;

create or replace function public.admin_delete_route_template(session_token text, id uuid)
returns void language plpgsql volatile security definer set search_path = public
as $$
begin
  perform public._session_admin(session_token);
  delete from public.route_templates rt where rt.id = admin_delete_route_template.id;  -- segments + asset links cascade
  if not found then raise exception 'template not found' using errcode = 'P0002'; end if;
end;
$$;

-- ============================================================================
-- Duty slot definitions (fixed recurring shifts)
-- ============================================================================
create or replace function public.admin_list_duty_slots(session_token text)
returns jsonb language plpgsql stable security definer set search_path = public
as $$
declare v_out jsonb;
begin
  perform public._session_admin(session_token);
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', d.id, 'site_id', d.site_id, 'duty_type_id', d.duty_type_id, 'label', d.label,
    'start_time', d.start_time, 'end_time', d.end_time, 'weekdays', d.weekdays,
    'worker_count', d.worker_count, 'is_active', d.is_active,
    'eligible_worker_ids', coalesce((select array_agg(w.employee_id) from public.duty_slot_eligible_workers w where w.duty_slot_id = d.id), '{}')
  ) order by d.is_active desc, d.label), '[]'::jsonb) into v_out from public.duty_slot_definitions d;
  return v_out;
end;
$$;

create or replace function public.admin_save_duty_slot(
  session_token text, id uuid, site_id text, duty_type_id uuid, label text,
  start_time time, end_time time, weekdays int[], worker_count int, is_active boolean)
returns uuid language plpgsql volatile security definer set search_path = public
as $$
declare v_id uuid;
begin
  perform public._session_admin(session_token);
  if admin_save_duty_slot.id is null then
    insert into public.duty_slot_definitions (site_id, duty_type_id, label, start_time, end_time, weekdays, worker_count, is_active)
    values (admin_save_duty_slot.site_id, admin_save_duty_slot.duty_type_id, nullif(btrim(label), ''),
            admin_save_duty_slot.start_time, admin_save_duty_slot.end_time,
            coalesce(weekdays, '{0,1,2,3,4,5,6}'), greatest(1, coalesce(worker_count, 1)), coalesce(is_active, true))
    returning duty_slot_definitions.id into v_id;
  else
    v_id := admin_save_duty_slot.id;
    update public.duty_slot_definitions d set
      site_id = admin_save_duty_slot.site_id, duty_type_id = admin_save_duty_slot.duty_type_id, label = nullif(btrim(admin_save_duty_slot.label), ''),
      start_time = admin_save_duty_slot.start_time, end_time = admin_save_duty_slot.end_time,
      weekdays = coalesce(admin_save_duty_slot.weekdays, d.weekdays),
      worker_count = greatest(1, coalesce(admin_save_duty_slot.worker_count, d.worker_count)),
      is_active = coalesce(admin_save_duty_slot.is_active, d.is_active)
     where d.id = v_id;
    if not found then raise exception 'slot not found' using errcode = 'P0002'; end if;
  end if;
  return v_id;
end;
$$;

create or replace function public.admin_set_duty_slot_workers(session_token text, duty_slot_id uuid, employee_ids uuid[])
returns void language plpgsql volatile security definer set search_path = public
as $$
declare v_e uuid;
begin
  perform public._session_admin(session_token);
  delete from public.duty_slot_eligible_workers w where w.duty_slot_id = admin_set_duty_slot_workers.duty_slot_id;
  if employee_ids is not null then
    foreach v_e in array employee_ids loop
      insert into public.duty_slot_eligible_workers (duty_slot_id, employee_id) values (admin_set_duty_slot_workers.duty_slot_id, v_e) on conflict do nothing;
    end loop;
  end if;
end;
$$;

create or replace function public.admin_delete_duty_slot(session_token text, id uuid)
returns void language plpgsql volatile security definer set search_path = public
as $$
begin
  perform public._session_admin(session_token);
  delete from public.duty_slot_definitions d where d.id = admin_delete_duty_slot.id;
  if not found then raise exception 'slot not found' using errcode = 'P0002'; end if;
end;
$$;

-- ============================================================================
-- THE ENGINE: generate a planned week
-- ============================================================================
create or replace function public.admin_generate_week(session_token text, week_start_date date)
returns jsonb language plpgsql volatile security definer set search_path = public
as $$
declare
  v_factory text; v_tc int := 0; v_dc int := 0; v_skipped text[] := '{}'; v_note text := '';
  v_d int; v_date date; v_dow int;
  a record; slot record;
  v_rt uuid; v_entry uuid; v_tpl uuid; v_checklist jsonb;
  v_workers uuid[]; v_vehicles text[]; v_trip uuid; v_w uuid; v_v text;
  v_start timestamptz; v_end timestamptz; v_shift uuid;
begin
  perform public._session_admin(session_token);

  select s.id into v_factory
  from public.sites s join public.site_types st on st.id = s.site_type_id
  where st.label = 'מפעל' and s.is_active = true
  order by s.id limit 1;
  if v_factory is null then v_note := 'אין אתר פעיל מסוג "מפעל" — לא נוצרו נסיעות'; end if;

  for v_d in 0..6 loop
    v_date := week_start_date + v_d;
    v_dow := extract(dow from v_date)::int;  -- 0=Sunday .. 6=Saturday

    -- ---- trips, per eligible asset ----
    if v_factory is not null then
      for a in select * from public.assets where is_active = true loop
        -- scheduled this weekday?
        if not exists (select 1 from public.asset_weekdays w where w.asset_id = a.id and w.weekday = v_dow) then continue; end if;
        -- already has a trip that day? (manual or generated)
        if exists (select 1 from public.trips t join public.trip_items ti on ti.trip_id = t.id
                   where ti.asset_id = a.id and t.scheduled_date = v_date) then continue; end if;
        -- a route template is mandatory
        select rt.id, rt.entry_point_id into v_rt, v_entry
        from public.route_templates rt join public.asset_eligible_route_templates aert on aert.route_template_id = rt.id
        where aert.asset_id = a.id and rt.is_active = true
        order by random() limit 1;
        if v_rt is null then
          if not (a.id = any(v_skipped)) then v_skipped := array_append(v_skipped, a.id); end if;
          continue;
        end if;

        -- random workers / vehicles from pools (empty pool = all active)
        select coalesce(array_agg(id), '{}') into v_workers from (
          select e.id from public.employees e
          where e.is_active = true and (
            not exists (select 1 from public.asset_eligible_workers x where x.asset_id = a.id)
            or exists (select 1 from public.asset_eligible_workers x where x.asset_id = a.id and x.employee_id = e.id))
          order by random() limit greatest(1, a.gen_worker_count)) q;
        select coalesce(array_agg(id), '{}') into v_vehicles from (
          select vv.id from public.vehicles vv
          where vv.is_active = true and (
            not exists (select 1 from public.asset_eligible_vehicles x where x.asset_id = a.id)
            or exists (select 1 from public.asset_eligible_vehicles x where x.asset_id = a.id and x.vehicle_id = vv.id))
          order by random() limit greatest(0, a.gen_vehicle_count)) q;

        select act.checklist_template_id into v_tpl from public.asset_checklist_templates act
         where act.asset_id = a.id order by act.checklist_template_id limit 1;
        select coalesce(jsonb_agg(jsonb_build_object('label', ci.label, 'critical', ci.critical, 'checked', false)
                                  order by ci.sort_order, ci.label), '[]'::jsonb) into v_checklist
          from public.checklist_items ci where ci.template_id = v_tpl and ci.is_active = true;

        insert into public.trips (from_site_id, to_site_id, scheduled_date, status, planned_entry_point_id, label, audit_log)
        values (a.home_site_id, v_factory, v_date, 'planned', v_entry, 'הוגרל אוטומטית',
                jsonb_build_array(to_char(now(), 'HH24:MI') || ' – Auto-generated'))
        returning id into v_trip;

        if v_workers is not null then foreach v_w in array v_workers loop
          insert into public.trip_workers (trip_id, employee_id) values (v_trip, v_w) on conflict do nothing; end loop; end if;
        if v_vehicles is not null then foreach v_v in array v_vehicles loop
          insert into public.trip_vehicles (trip_id, vehicle_id) values (v_trip, v_v) on conflict do nothing; end loop; end if;
        insert into public.trip_route_segments (trip_id, sequence, route_id, checkpoint_note)
          select v_trip, s.sequence, s.route_id, s.checkpoint_note from public.route_template_segments s where s.route_template_id = v_rt;
        insert into public.trip_items (trip_id, asset_id, checklist, checklist_note)
          values (v_trip, a.id, coalesce(v_checklist, '[]'::jsonb), null);
        v_tc := v_tc + 1;
      end loop;
    end if;

    -- ---- duty shifts, per slot ----
    for slot in select * from public.duty_slot_definitions where is_active = true loop
      if not (v_dow = any(slot.weekdays)) then continue; end if;
      if exists (select 1 from public.duty_shifts d where d.slot_id = slot.id and d.start_time::date = v_date) then continue; end if;

      select coalesce(array_agg(id), '{}') into v_workers from (
        select e.id from public.employees e
        where e.is_active = true and (
          not exists (select 1 from public.duty_slot_eligible_workers x where x.duty_slot_id = slot.id)
          or exists (select 1 from public.duty_slot_eligible_workers x where x.duty_slot_id = slot.id and x.employee_id = e.id))
        order by random() limit greatest(1, slot.worker_count)) q;

      select dtct.checklist_template_id into v_tpl from public.duty_type_checklist_templates dtct
       where dtct.duty_type_id = slot.duty_type_id order by dtct.checklist_template_id limit 1;
      select coalesce(jsonb_agg(jsonb_build_object('label', ci.label, 'critical', ci.critical, 'checked', false)
                                order by ci.sort_order, ci.label), '[]'::jsonb) into v_checklist
        from public.checklist_items ci where ci.template_id = v_tpl and ci.is_active = true;

      v_start := (v_date + slot.start_time)::timestamptz;
      v_end := (v_date + slot.end_time)::timestamptz;
      if slot.end_time <= slot.start_time then v_end := v_end + interval '1 day'; end if;

      insert into public.duty_shifts (site_id, duty_type_id, start_time, end_time, status, slot_id, label, checklist_template_id, checklist, audit_log)
      values (slot.site_id, slot.duty_type_id, v_start, v_end, 'planned', slot.id, coalesce(slot.label, 'הוגרל אוטומטית'),
              v_tpl, coalesce(v_checklist, '[]'::jsonb),
              jsonb_build_array(to_char(now(), 'HH24:MI') || ' – Auto-generated'))
      returning id into v_shift;
      if v_workers is not null then foreach v_w in array v_workers loop
        insert into public.duty_shift_workers (duty_shift_id, employee_id) values (v_shift, v_w) on conflict do nothing; end loop; end if;
      v_dc := v_dc + 1;
    end loop;
  end loop;

  return jsonb_build_object(
    'trips_created', v_tc, 'duties_created', v_dc,
    'skipped_assets', to_jsonb(v_skipped), 'note', v_note);
end;
$$;

-- ============================================================================
-- Reference reads for the client (non-sensitive): route templates list is admin;
-- open SELECT not needed. Grants:
-- ============================================================================
grant execute on function public.update_trip_item_checklist(text, uuid, jsonb, text) to anon, authenticated;
grant execute on function public.start_trip(text, uuid)                              to anon, authenticated;
grant execute on function public.complete_trip(text, uuid, jsonb)                    to anon, authenticated;
grant execute on function public.update_duty_checklist(text, uuid, jsonb, text)      to anon, authenticated;
grant execute on function public.start_duty(text, uuid)                              to anon, authenticated;
grant execute on function public.complete_duty(text, uuid, jsonb)                    to anon, authenticated;
grant execute on function public.list_my_trips(text)                                 to anon, authenticated;
grant execute on function public.list_my_duties(text)                                to anon, authenticated;
grant execute on function public.admin_list_asset_gen(text)                          to anon, authenticated;
grant execute on function public.admin_set_asset_gen_counts(text, text, int, int)    to anon, authenticated;
grant execute on function public.admin_set_asset_weekdays(text, text, int[])         to anon, authenticated;
grant execute on function public.admin_set_asset_eligible_workers(text, text, uuid[]) to anon, authenticated;
grant execute on function public.admin_set_asset_eligible_vehicles(text, text, text[]) to anon, authenticated;
grant execute on function public.admin_set_asset_route_templates(text, text, uuid[]) to anon, authenticated;
grant execute on function public.admin_list_route_templates(text)                    to anon, authenticated;
grant execute on function public.admin_save_route_template(text, uuid, text, uuid, boolean, jsonb) to anon, authenticated;
grant execute on function public.admin_delete_route_template(text, uuid)             to anon, authenticated;
grant execute on function public.admin_list_duty_slots(text)                         to anon, authenticated;
grant execute on function public.admin_save_duty_slot(text, uuid, text, uuid, text, time, time, int[], int, boolean) to anon, authenticated;
grant execute on function public.admin_set_duty_slot_workers(text, uuid, uuid[])     to anon, authenticated;
grant execute on function public.admin_delete_duty_slot(text, uuid)                  to anon, authenticated;
grant execute on function public.admin_generate_week(text, date)                     to anon, authenticated;

-- ----------------------------------------------------------------------------
-- Verify (admin token):
--   select public.admin_generate_week('<admin>', date_trunc('week', current_date + 7)::date);
--   select * from public.admin_list_asset_gen('<admin>');
--   select public.admin_list_route_templates('<admin>');
-- ----------------------------------------------------------------------------
