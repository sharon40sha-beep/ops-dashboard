-- =============================================================================
-- OPS Dashboard — 0016: admin edit of a still-PLANNED trip / duty shift.
--   Editing is allowed ONLY while status = 'planned'. Once a task is active or
--   completed it is frozen — what actually happened is already recorded through
--   actual + deviation + reason, so the plan is never rewritten after the fact.
--   This keeps the audit trail trustworthy.
--
--   No step-up (actor_pin): this is a correction to something that has not
--   happened yet, not a destructive action like delete / unlock.
--   Each edit appends an "Edited by admin: <fields>" line to the row's audit_log.
--
-- Depends on 0014/0015. No schema changes. Safe to re-run (idempotent).
-- =============================================================================

set search_path = public, extensions;

-- ============================================================================
-- update_trip — admin only; rejected unless status = 'planned'.
-- ============================================================================
create or replace function public.update_trip(
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
  asset_ids          text[]
)
returns jsonb language plpgsql volatile security definer set search_path = public
as $$
declare
  v_trip public.trips; v_changes text[] := '{}';
  v_old_w uuid[]; v_new_w uuid[];
  v_old_v text[]; v_new_v text[];
  v_old_r text[]; v_new_r text[];
  v_old_a text[]; v_new_a text[];
  v_asset text; v_tpl uuid; v_checklist jsonb; v_w uuid; v_v text; v_seg jsonb; v_i int := 0;
begin
  perform public._session_admin(session_token);
  select * into v_trip from public.trips where id = trip_id;
  if not found then raise exception 'trip not found' using errcode = 'P0002'; end if;
  if v_trip.status <> 'planned' then
    raise exception 'trip is not editable (already started)' using errcode = '22023';
  end if;
  if asset_ids is null or array_length(asset_ids, 1) is null then
    raise exception 'at least one asset required' using errcode = '22023';
  end if;
  if worker_ids is null or array_length(worker_ids, 1) is null then
    raise exception 'at least one worker required' using errcode = '22023';
  end if;
  if update_trip.scheduled_date is null then
    raise exception 'scheduled date required' using errcode = '22023';
  end if;

  -- capture old sets, then the new ones, for the audit-log field diff
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
  select array_agg(a order by a) into v_new_a from unnest(asset_ids) a;

  if v_trip.from_site_id           is distinct from update_trip.from_site_id       then v_changes := v_changes || 'מאתר'; end if;
  if v_trip.to_site_id             is distinct from update_trip.to_site_id         then v_changes := v_changes || 'לאתר'; end if;
  if v_trip.scheduled_date         is distinct from update_trip.scheduled_date     then v_changes := v_changes || 'תאריך'; end if;
  if v_trip.planned_start_time     is distinct from update_trip.planned_start_time then v_changes := v_changes || 'שעת התחלה'; end if;
  if v_trip.planned_end_time       is distinct from update_trip.planned_end_time   then v_changes := v_changes || 'שעת סיום'; end if;
  if v_trip.planned_entry_point_id is distinct from update_trip.entry_point_id     then v_changes := v_changes || 'שער'; end if;
  if coalesce(v_old_w, '{}') is distinct from coalesce(v_new_w, '{}') then v_changes := v_changes || 'עובדים'; end if;
  if coalesce(v_old_v, '{}') is distinct from coalesce(v_new_v, '{}') then v_changes := v_changes || 'רכבים'; end if;
  if coalesce(v_old_r, '{}') is distinct from coalesce(v_new_r, '{}') then v_changes := v_changes || 'מסלול'; end if;
  if coalesce(v_old_a, '{}') is distinct from coalesce(v_new_a, '{}') then v_changes := v_changes || 'מוצרים'; end if;

  update public.trips t set
    from_site_id           = update_trip.from_site_id,
    to_site_id             = update_trip.to_site_id,
    scheduled_date         = update_trip.scheduled_date,
    planned_start_time     = update_trip.planned_start_time,
    planned_end_time       = update_trip.planned_end_time,
    planned_entry_point_id = update_trip.entry_point_id,
    audit_log = t.audit_log || jsonb_build_array(to_char(now(), 'HH24:MI') || ' – Edited by admin: ' ||
      coalesce(nullif(array_to_string(v_changes, ', '), ''), 'ללא שינוי'))
  where t.id = update_trip.trip_id;

  -- replace workers / vehicles / route segments
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

  -- reconcile items: drop assets no longer present, add new ones with a fresh checklist,
  -- keep existing items (and any pre-checks) for assets that stay.
  delete from public.trip_items ti where ti.trip_id = update_trip.trip_id and ti.asset_id <> all(asset_ids);
  foreach v_asset in array asset_ids loop
    if not exists (select 1 from public.trip_items ti where ti.trip_id = update_trip.trip_id and ti.asset_id = v_asset) then
      select a.checklist_template_id into v_tpl from public.assets a where a.id = v_asset;
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

-- ============================================================================
-- update_duty_shift — admin only; rejected unless status = 'planned'.
-- (start_time/end_time are full timestamptz and already carry the date, so no
--  separate scheduled_date column is needed for shifts.)
-- ============================================================================
create or replace function public.update_duty_shift(
  session_token text,
  duty_shift_id uuid,
  site_id       text,
  worker_ids    uuid[],
  duty_type_id  uuid,
  start_time    timestamptz,
  end_time      timestamptz
)
returns jsonb language plpgsql volatile security definer set search_path = public
as $$
declare
  v_shift public.duty_shifts; v_changes text[] := '{}';
  v_old_w uuid[]; v_new_w uuid[]; v_tpl uuid; v_checklist jsonb; v_w uuid; v_type_changed boolean;
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

  select array_agg(dw.employee_id order by dw.employee_id) into v_old_w from public.duty_shift_workers dw where dw.duty_shift_id = update_duty_shift.duty_shift_id;
  select array_agg(w order by w) into v_new_w from unnest(worker_ids) w;
  v_type_changed := v_shift.duty_type_id is distinct from update_duty_shift.duty_type_id;

  if v_shift.site_id    is distinct from update_duty_shift.site_id    then v_changes := v_changes || 'אתר'; end if;
  if v_type_changed                                                   then v_changes := v_changes || 'סוג משמרת'; end if;
  if v_shift.start_time is distinct from update_duty_shift.start_time then v_changes := v_changes || 'התחלה'; end if;
  if v_shift.end_time   is distinct from update_duty_shift.end_time   then v_changes := v_changes || 'סיום'; end if;
  if coalesce(v_old_w, '{}') is distinct from coalesce(v_new_w, '{}') then v_changes := v_changes || 'עובדים'; end if;

  -- if the duty type changed, rebuild the checklist from the new type's template
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
-- Privileges
-- ============================================================================
grant execute on function public.update_trip(text, uuid, text, text, uuid[], text[], jsonb, uuid, date, time, time, text[]) to anon, authenticated;
grant execute on function public.update_duty_shift(text, uuid, text, uuid[], uuid, timestamptz, timestamptz)               to anon, authenticated;

-- ----------------------------------------------------------------------------
-- Verify (with an admin token, on a PLANNED trip):
--   select public.update_trip('<admin>','<trip-uuid>','S01','S07',
--     array['<w-uuid>']::uuid[], array['V-1'], '[{"sequence":1,"route_id":"Blue"}]'::jsonb,
--     null, current_date, '08:00', '09:30', array['A1']);
-- ----------------------------------------------------------------------------
