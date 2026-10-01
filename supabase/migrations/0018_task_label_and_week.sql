-- =============================================================================
-- OPS Dashboard — 0018: free-text display label + weekly preview.
--   * trips / duty_shifts gain `label` (text, nullable) — a free display tag the
--     admin writes on create/edit (e.g. "משימת בוקר", "סיור"). NOT derived from
--     anything, never a real operational detail.
--   * list_my_week / list_week_for_employee return a minimal week view:
--     id, scheduled_date, label, type ('trip'|'duty'), status — nothing else.
--
-- Depends on 0014–0017. Recreates the create/update trip+duty RPCs to accept the
-- label. Safe to re-run (idempotent).
-- =============================================================================

set search_path = public, extensions;

alter table public.trips       add column if not exists label text;
alter table public.duty_shifts add column if not exists label text;

-- ============================================================================
-- Recreate create/update trip + duty RPCs with a label parameter.
-- (Signatures change -> drop the 0014/0016/0017 versions first.)
-- ============================================================================
drop function if exists public.create_trip(text, text, text, uuid[], text[], jsonb, uuid, date, time, time, jsonb, uuid);
drop function if exists public.update_trip(text, uuid, text, text, uuid[], text[], jsonb, uuid, date, time, time, jsonb);
drop function if exists public.create_duty_shift(text, text, uuid[], uuid, timestamptz, timestamptz);
drop function if exists public.update_duty_shift(text, uuid, text, uuid[], uuid, timestamptz, timestamptz);

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
  p_assets           jsonb,
  return_of_trip_id  uuid,
  p_label            text
)
returns jsonb language plpgsql volatile security definer set search_path = public
as $$
declare v_trip public.trips; v_item jsonb; v_asset text; v_tpl uuid; v_checklist jsonb;
        v_w uuid; v_v text; v_seg jsonb; v_i int := 0;
begin
  perform public._session_admin(session_token);
  if p_assets is null or jsonb_typeof(p_assets) <> 'array' or jsonb_array_length(p_assets) = 0 then
    raise exception 'at least one asset required' using errcode = '22023';
  end if;
  if worker_ids is null or array_length(worker_ids, 1) is null then
    raise exception 'at least one worker required' using errcode = '22023';
  end if;
  if create_trip.scheduled_date is null then
    raise exception 'scheduled date required' using errcode = '22023';
  end if;

  insert into public.trips (from_site_id, to_site_id, scheduled_date, planned_start_time, planned_end_time,
                            label, status, return_of_trip_id, planned_entry_point_id, audit_log)
  values (create_trip.from_site_id, create_trip.to_site_id, create_trip.scheduled_date,
          create_trip.planned_start_time, create_trip.planned_end_time, nullif(btrim(p_label), ''),
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

  for v_item in select value from jsonb_array_elements(p_assets) loop
    v_asset := btrim(v_item->>'asset_id');
    if nullif(v_asset, '') is null then continue; end if;
    v_tpl := nullif(v_item->>'template_id', '')::uuid;
    select coalesce(jsonb_agg(jsonb_build_object('label', ci.label, 'critical', ci.critical, 'checked', false)
                              order by ci.sort_order, ci.label), '[]'::jsonb)
      into v_checklist
      from public.checklist_items ci where ci.template_id = v_tpl and ci.is_active = true;
    insert into public.trip_items (trip_id, asset_id, checklist, checklist_note)
    values (v_trip.id, v_asset, coalesce(v_checklist, '[]'::jsonb), null) on conflict do nothing;
  end loop;

  return (select public._trip_json(t) from public.trips t where t.id = v_trip.id);
end;
$$;

create function public.update_trip(
  session_token      text,
  trip_id            uuid,
  from_site_id       text,
  to_site_id         text,
  worker_ids         uuid[],
  vehicle_ids        text[],
  route_segments     jsonb,
  entry_point_id     uuid,
  scheduled_date     date,
  planned_start_time time,
  planned_end_time   time,
  p_assets           jsonb,
  p_label            text
)
returns jsonb language plpgsql volatile security definer set search_path = public
as $$
declare
  v_trip public.trips; v_changes text[] := '{}';
  v_old_w uuid[]; v_new_w uuid[];
  v_old_v text[]; v_new_v text[];
  v_old_r text[]; v_new_r text[];
  v_old_a text[]; v_new_a text[];
  v_item jsonb; v_asset text; v_tpl uuid; v_checklist jsonb; v_w uuid; v_v text; v_seg jsonb; v_i int := 0;
  v_label text;
begin
  perform public._session_admin(session_token);
  select * into v_trip from public.trips where id = trip_id;
  if not found then raise exception 'trip not found' using errcode = 'P0002'; end if;
  if v_trip.status <> 'planned' then
    raise exception 'trip is not editable (already started)' using errcode = '22023';
  end if;
  if p_assets is null or jsonb_typeof(p_assets) <> 'array' or jsonb_array_length(p_assets) = 0 then
    raise exception 'at least one asset required' using errcode = '22023';
  end if;
  if worker_ids is null or array_length(worker_ids, 1) is null then
    raise exception 'at least one worker required' using errcode = '22023';
  end if;
  if update_trip.scheduled_date is null then
    raise exception 'scheduled date required' using errcode = '22023';
  end if;

  v_label := nullif(btrim(p_label), '');

  select array_agg(tw.employee_id order by tw.employee_id) into v_old_w from public.trip_workers tw        where tw.trip_id = update_trip.trip_id;
  select array_agg(tv.vehicle_id order by tv.vehicle_id)   into v_old_v from public.trip_vehicles tv       where tv.trip_id = update_trip.trip_id;
  select array_agg(s.route_id order by s.sequence)         into v_old_r from public.trip_route_segments s  where s.trip_id  = update_trip.trip_id;
  select array_agg(ti.asset_id order by ti.asset_id)       into v_old_a from public.trip_items ti          where ti.trip_id = update_trip.trip_id;

  select array_agg(w order by w) into v_new_w from unnest(worker_ids) w;
  select array_agg(btrim(v) order by btrim(v)) into v_new_v from unnest(vehicle_ids) v where nullif(btrim(v), '') is not null;
  select array_agg(rid order by ord) into v_new_r from (
    select btrim(e.value->>'route_id') rid, e.ordinality ord
    from jsonb_array_elements(coalesce(route_segments, '[]'::jsonb)) with ordinality as e(value, ordinality)
    where nullif(btrim(e.value->>'route_id'), '') is not null) q;
  select array_agg(aid order by aid) into v_new_a from (
    select btrim(e.value->>'asset_id') aid from jsonb_array_elements(p_assets) e
    where nullif(btrim(e.value->>'asset_id'), '') is not null) q;

  if v_trip.from_site_id           is distinct from update_trip.from_site_id       then v_changes := array_append(v_changes, 'מאתר'); end if;
  if v_trip.to_site_id             is distinct from update_trip.to_site_id         then v_changes := array_append(v_changes, 'לאתר'); end if;
  if v_trip.scheduled_date         is distinct from update_trip.scheduled_date     then v_changes := array_append(v_changes, 'תאריך'); end if;
  if v_trip.planned_start_time     is distinct from update_trip.planned_start_time then v_changes := array_append(v_changes, 'שעת התחלה'); end if;
  if v_trip.planned_end_time       is distinct from update_trip.planned_end_time   then v_changes := array_append(v_changes, 'שעת סיום'); end if;
  if v_trip.planned_entry_point_id is distinct from update_trip.entry_point_id     then v_changes := array_append(v_changes, 'שער'); end if;
  if v_trip.label                  is distinct from v_label                        then v_changes := array_append(v_changes, 'תווית'); end if;
  if coalesce(v_old_w, '{}') is distinct from coalesce(v_new_w, '{}') then v_changes := array_append(v_changes, 'עובדים'); end if;
  if coalesce(v_old_v, '{}') is distinct from coalesce(v_new_v, '{}') then v_changes := array_append(v_changes, 'רכבים'); end if;
  if coalesce(v_old_r, '{}') is distinct from coalesce(v_new_r, '{}') then v_changes := array_append(v_changes, 'מסלול'); end if;
  if coalesce(v_old_a, '{}') is distinct from coalesce(v_new_a, '{}') then v_changes := array_append(v_changes, 'מוצרים'); end if;

  update public.trips t set
    from_site_id           = update_trip.from_site_id,
    to_site_id             = update_trip.to_site_id,
    scheduled_date         = update_trip.scheduled_date,
    planned_start_time     = update_trip.planned_start_time,
    planned_end_time       = update_trip.planned_end_time,
    label                  = v_label,
    planned_entry_point_id = update_trip.entry_point_id,
    audit_log = t.audit_log || jsonb_build_array(to_char(now(), 'HH24:MI') || ' – Edited by admin: ' ||
      coalesce(nullif(array_to_string(v_changes, ', '), ''), 'ללא שינוי'))
  where t.id = update_trip.trip_id;

  delete from public.trip_workers        tw where tw.trip_id = update_trip.trip_id;
  delete from public.trip_vehicles       tv where tv.trip_id = update_trip.trip_id;
  delete from public.trip_route_segments s  where s.trip_id  = update_trip.trip_id;

  foreach v_w in array worker_ids loop
    insert into public.trip_workers (trip_id, employee_id) values (update_trip.trip_id, v_w) on conflict do nothing;
  end loop;
  if vehicle_ids is not null then
    foreach v_v in array vehicle_ids loop
      if nullif(btrim(v_v), '') is not null then
        insert into public.trip_vehicles (trip_id, vehicle_id) values (update_trip.trip_id, btrim(v_v)) on conflict do nothing;
      end if;
    end loop;
  end if;
  if route_segments is not null and jsonb_typeof(route_segments) = 'array' then
    for v_seg in select value from jsonb_array_elements(route_segments) loop
      if nullif(btrim(v_seg->>'route_id'), '') is not null then
        v_i := v_i + 1;
        insert into public.trip_route_segments (trip_id, sequence, route_id, checkpoint_note)
        values (update_trip.trip_id, coalesce((v_seg->>'sequence')::int, v_i), btrim(v_seg->>'route_id'),
                nullif(btrim(v_seg->>'checkpoint_note'), ''));
      end if;
    end loop;
  end if;

  delete from public.trip_items ti where ti.trip_id = update_trip.trip_id and ti.asset_id <> all(v_new_a);
  for v_item in select value from jsonb_array_elements(p_assets) loop
    v_asset := btrim(v_item->>'asset_id');
    if nullif(v_asset, '') is null then continue; end if;
    if not exists (select 1 from public.trip_items ti where ti.trip_id = update_trip.trip_id and ti.asset_id = v_asset) then
      v_tpl := nullif(v_item->>'template_id', '')::uuid;
      select coalesce(jsonb_agg(jsonb_build_object('label', ci.label, 'critical', ci.critical, 'checked', false)
                                order by ci.sort_order, ci.label), '[]'::jsonb)
        into v_checklist from public.checklist_items ci where ci.template_id = v_tpl and ci.is_active = true;
      insert into public.trip_items (trip_id, asset_id, checklist, checklist_note)
      values (update_trip.trip_id, v_asset, coalesce(v_checklist, '[]'::jsonb), null);
    end if;
  end loop;

  return (select public._trip_json(t) from public.trips t where t.id = update_trip.trip_id);
end;
$$;

create function public.create_duty_shift(
  session_token text, site_id text, worker_ids uuid[], duty_type_id uuid,
  start_time timestamptz, end_time timestamptz, p_label text)
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

  insert into public.duty_shifts (site_id, duty_type_id, start_time, end_time, label, status, checklist, audit_log)
  values (create_duty_shift.site_id, create_duty_shift.duty_type_id,
          create_duty_shift.start_time, create_duty_shift.end_time, nullif(btrim(p_label), ''), 'planned',
          coalesce(v_checklist, '[]'::jsonb),
          jsonb_build_array(to_char(now(), 'HH24:MI') || ' – Shift created'))
  returning * into v_shift;

  foreach v_w in array worker_ids loop
    insert into public.duty_shift_workers (duty_shift_id, employee_id) values (v_shift.id, v_w) on conflict do nothing;
  end loop;

  return (select public._duty_json(d) from public.duty_shifts d where d.id = v_shift.id);
end;
$$;

create function public.update_duty_shift(
  session_token text, duty_shift_id uuid, site_id text, worker_ids uuid[], duty_type_id uuid,
  start_time timestamptz, end_time timestamptz, p_label text)
returns jsonb language plpgsql volatile security definer set search_path = public
as $$
declare
  v_shift public.duty_shifts; v_changes text[] := '{}';
  v_old_w uuid[]; v_new_w uuid[]; v_tpl uuid; v_checklist jsonb; v_w uuid; v_type_changed boolean; v_label text;
begin
  perform public._session_admin(session_token);
  select * into v_shift from public.duty_shifts where id = duty_shift_id;
  if not found then raise exception 'shift not found' using errcode = 'P0002'; end if;
  if v_shift.status <> 'planned' then
    raise exception 'shift is not editable (already started)' using errcode = '22023';
  end if;
  if worker_ids is null or array_length(worker_ids, 1) is null then
    raise exception 'at least one worker required' using errcode = '22023';
  end if;

  v_label := nullif(btrim(p_label), '');
  select array_agg(dw.employee_id order by dw.employee_id) into v_old_w from public.duty_shift_workers dw where dw.duty_shift_id = update_duty_shift.duty_shift_id;
  select array_agg(w order by w) into v_new_w from unnest(worker_ids) w;
  v_type_changed := v_shift.duty_type_id is distinct from update_duty_shift.duty_type_id;

  if v_shift.site_id    is distinct from update_duty_shift.site_id    then v_changes := array_append(v_changes, 'אתר'); end if;
  if v_type_changed                                                   then v_changes := array_append(v_changes, 'סוג משמרת'); end if;
  if v_shift.start_time is distinct from update_duty_shift.start_time then v_changes := array_append(v_changes, 'התחלה'); end if;
  if v_shift.end_time   is distinct from update_duty_shift.end_time   then v_changes := array_append(v_changes, 'סיום'); end if;
  if v_shift.label      is distinct from v_label                      then v_changes := array_append(v_changes, 'תווית'); end if;
  if coalesce(v_old_w, '{}') is distinct from coalesce(v_new_w, '{}') then v_changes := array_append(v_changes, 'עובדים'); end if;

  if v_type_changed then
    select dt.checklist_template_id into v_tpl from public.duty_types dt where dt.id = update_duty_shift.duty_type_id;
    select coalesce(jsonb_agg(jsonb_build_object('label', ci.label, 'critical', ci.critical, 'checked', false)
                              order by ci.sort_order, ci.label), '[]'::jsonb)
      into v_checklist from public.checklist_items ci where ci.template_id = v_tpl and ci.is_active = true;
  end if;

  update public.duty_shifts d set
    site_id      = update_duty_shift.site_id,
    duty_type_id = update_duty_shift.duty_type_id,
    start_time   = update_duty_shift.start_time,
    end_time     = update_duty_shift.end_time,
    label        = v_label,
    checklist      = case when v_type_changed then coalesce(v_checklist, '[]'::jsonb) else d.checklist end,
    checklist_note = case when v_type_changed then null else d.checklist_note end,
    audit_log = d.audit_log || jsonb_build_array(to_char(now(), 'HH24:MI') || ' – Edited by admin: ' ||
      coalesce(nullif(array_to_string(v_changes, ', '), ''), 'ללא שינוי'))
  where d.id = update_duty_shift.duty_shift_id;

  delete from public.duty_shift_workers dw where dw.duty_shift_id = update_duty_shift.duty_shift_id;
  foreach v_w in array worker_ids loop
    insert into public.duty_shift_workers (duty_shift_id, employee_id) values (update_duty_shift.duty_shift_id, v_w) on conflict do nothing;
  end loop;

  return (select public._duty_json(d) from public.duty_shifts d where d.id = update_duty_shift.duty_shift_id);
end;
$$;

-- ============================================================================
-- Weekly preview — minimal fields only (no vehicle/route/site/exact time).
-- ============================================================================
create or replace function public._week_json(p_emp uuid, p_from date)
returns jsonb language sql stable set search_path = public
as $$
  with wk as (
    select tr.id, tr.scheduled_date, tr.label, 'trip'::text as type, tr.status
    from public.trips tr
    where tr.scheduled_date between p_from and (p_from + 6)
      and public._is_trip_member(tr.id, p_emp)
    union all
    select ds.id, (ds.start_time)::date, ds.label, 'duty'::text, ds.status
    from public.duty_shifts ds
    where (ds.start_time)::date between p_from and (p_from + 6)
      and public._is_duty_member(ds.id, p_emp)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', id, 'scheduled_date', scheduled_date, 'label', label, 'type', type, 'status', status
  ) order by scheduled_date, type), '[]'::jsonb)
  from wk;
$$;
revoke all on function public._week_json(uuid, date) from public;

create or replace function public.list_my_week(session_token text, week_start_date date)
returns jsonb language plpgsql stable security definer set search_path = public
as $$
declare v_id uuid;
begin
  v_id := public._session_employee(session_token);
  return public._week_json(v_id, week_start_date);
end;
$$;

create or replace function public.list_week_for_employee(session_token text, employee_id uuid, week_start_date date)
returns jsonb language plpgsql stable security definer set search_path = public
as $$
begin
  perform public._session_admin(session_token);
  return public._week_json(list_week_for_employee.employee_id, week_start_date);
end;
$$;

-- ============================================================================
-- Privileges
-- ============================================================================
grant execute on function public.create_trip(text, text, text, uuid[], text[], jsonb, uuid, date, time, time, jsonb, uuid, text) to anon, authenticated;
grant execute on function public.update_trip(text, uuid, text, text, uuid[], text[], jsonb, uuid, date, time, time, jsonb, text) to anon, authenticated;
grant execute on function public.create_duty_shift(text, text, uuid[], uuid, timestamptz, timestamptz, text) to anon, authenticated;
grant execute on function public.update_duty_shift(text, uuid, text, uuid[], uuid, timestamptz, timestamptz, text) to anon, authenticated;
grant execute on function public.list_my_week(text, date)                        to anon, authenticated;
grant execute on function public.list_week_for_employee(text, uuid, date)        to anon, authenticated;

-- ----------------------------------------------------------------------------
-- Verify (with valid tokens):
--   select public.list_my_week('<token>', date_trunc('week', current_date)::date);
--   select public.list_week_for_employee('<admin>', '<emp-uuid>', current_date);
-- ----------------------------------------------------------------------------
