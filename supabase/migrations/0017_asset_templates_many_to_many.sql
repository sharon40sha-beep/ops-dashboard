-- =============================================================================
-- OPS Dashboard — 0017: asset ↔ checklist-template becomes many-to-many.
--   Before: one asset had exactly one fixed template (assets.checklist_template_id).
--   Now:    an asset can be linked to several templates (e.g. a morning-activity
--           template and a separate trip template); when a task is created the
--           admin picks the relevant one for that specific task. If the asset has
--           only one linked template it is chosen automatically.
--
--   The checklist copied into a trip_item still snapshots the chosen template's
--   active items, exactly as before.
--
-- Depends on 0011–0016. Migrates the existing single link before dropping it.
-- Safe to re-run (idempotent).
-- =============================================================================

set search_path = public, extensions;

-- ============================================================================
-- Link table (closed — reached only via the SECURITY DEFINER RPCs).
-- ============================================================================
create table if not exists public.asset_checklist_templates (
  asset_id              text not null references public.assets(id) on delete cascade,
  checklist_template_id uuid not null references public.checklist_templates(id),
  primary key (asset_id, checklist_template_id)
);
create index if not exists idx_act_template on public.asset_checklist_templates (checklist_template_id);
alter table public.asset_checklist_templates enable row level security;

-- migrate the existing single link, then drop the column
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='assets' and column_name='checklist_template_id') then
    insert into public.asset_checklist_templates (asset_id, checklist_template_id)
      select id, checklist_template_id from public.assets where checklist_template_id is not null
      on conflict do nothing;
  end if;
end $$;

alter table public.assets drop column if exists checklist_template_id;

-- ============================================================================
-- Asset admin RPCs (signatures change -> drop first).
-- ============================================================================
drop function if exists public.admin_list_assets(text);
drop function if exists public.admin_add_asset(text, text, text, uuid);
drop function if exists public.admin_update_asset(text, text, text, boolean, uuid);

create function public.admin_list_assets(session_token text)
returns table (id text, home_site_id text, is_active boolean, template_ids uuid[])
language plpgsql stable security definer set search_path = public
as $$
begin
  perform public._session_admin(session_token);
  return query
    select a.id, a.home_site_id, a.is_active,
           coalesce((select array_agg(act.checklist_template_id order by act.checklist_template_id)
                     from public.asset_checklist_templates act where act.asset_id = a.id), '{}')
    from public.assets a order by a.id;
end;
$$;

create function public.admin_add_asset(session_token text, id text, home_site_id text, template_ids uuid[])
returns void language plpgsql volatile security definer set search_path = public
as $$
declare v_t uuid;
begin
  perform public._session_admin(session_token);
  if coalesce(btrim(admin_add_asset.id), '') = '' then raise exception 'code required' using errcode = '22023'; end if;
  insert into public.assets (id, home_site_id, is_active) values (btrim(admin_add_asset.id), admin_add_asset.home_site_id, true);
  if template_ids is not null then
    foreach v_t in array template_ids loop
      insert into public.asset_checklist_templates (asset_id, checklist_template_id)
      values (btrim(admin_add_asset.id), v_t) on conflict do nothing;
    end loop;
  end if;
end;
$$;

create function public.admin_update_asset(session_token text, id text, home_site_id text, is_active boolean)
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

-- replace an asset's whole set of linked templates
create or replace function public.admin_set_asset_templates(session_token text, asset_id text, template_ids uuid[])
returns void language plpgsql volatile security definer set search_path = public
as $$
declare v_t uuid;
begin
  perform public._session_admin(session_token);
  if not exists (select 1 from public.assets a where a.id = admin_set_asset_templates.asset_id) then
    raise exception 'asset not found' using errcode = 'P0002';
  end if;
  delete from public.asset_checklist_templates act where act.asset_id = admin_set_asset_templates.asset_id;
  if template_ids is not null then
    foreach v_t in array template_ids loop
      insert into public.asset_checklist_templates (asset_id, checklist_template_id)
      values (admin_set_asset_templates.asset_id, v_t) on conflict do nothing;
    end loop;
  end if;
end;
$$;

-- ============================================================================
-- create_trip / update_trip: assets now carry a chosen template each.
--   p_assets jsonb = [{ "asset_id": "A1", "template_id": "<uuid|null>" }, ...]
-- ============================================================================
drop function if exists public.create_trip(text, text, text, uuid[], text[], jsonb, uuid, date, time, time, text[], uuid);

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
  return_of_trip_id  uuid
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

  for v_item in select value from jsonb_array_elements(p_assets) loop
    v_asset := btrim(v_item->>'asset_id');
    if nullif(v_asset, '') is null then continue; end if;
    v_tpl := nullif(v_item->>'template_id', '')::uuid;
    select coalesce(jsonb_agg(jsonb_build_object('label', ci.label, 'critical', ci.critical, 'checked', false)
                              order by ci.sort_order, ci.label), '[]'::jsonb)
      into v_checklist
      from public.checklist_items ci where ci.template_id = v_tpl and ci.is_active = true;
    insert into public.trip_items (trip_id, asset_id, checklist, checklist_note)
    values (v_trip.id, v_asset, coalesce(v_checklist, '[]'::jsonb), null)
    on conflict do nothing;
  end loop;

  return (select public._trip_json(t) from public.trips t where t.id = v_trip.id);
end;
$$;

drop function if exists public.update_trip(text, uuid, text, text, uuid[], text[], jsonb, uuid, date, time, time, text[]);

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
  p_assets           jsonb
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

  -- reconcile items: drop assets no longer present; add new ones with the chosen
  -- template's checklist; keep existing items (and pre-checks) for assets that stay.
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

-- ============================================================================
-- Privileges
-- ============================================================================
grant execute on function public.admin_list_assets(text)                                           to anon, authenticated;
grant execute on function public.admin_add_asset(text, text, text, uuid[])                          to anon, authenticated;
grant execute on function public.admin_update_asset(text, text, text, boolean)                      to anon, authenticated;
grant execute on function public.admin_set_asset_templates(text, text, uuid[])                      to anon, authenticated;
grant execute on function public.create_trip(text, text, text, uuid[], text[], jsonb, uuid, date, time, time, jsonb, uuid) to anon, authenticated;
grant execute on function public.update_trip(text, uuid, text, text, uuid[], text[], jsonb, uuid, date, time, time, jsonb) to anon, authenticated;

-- ----------------------------------------------------------------------------
-- Verify (with an admin token):
--   select * from public.admin_list_assets('<admin>');
--   select public.admin_set_asset_templates('<admin>','A1', array['<tpl-uuid>','<tpl2-uuid>']::uuid[]);
--   select public.create_trip('<admin>','S01','S07', array['<w>']::uuid[], array['V-1'],
--     '[{"sequence":1,"route_id":"Blue"}]'::jsonb, null, current_date, '08:00','09:30',
--     '[{"asset_id":"A1","template_id":"<tpl-uuid>"}]'::jsonb, null);
-- ----------------------------------------------------------------------------
