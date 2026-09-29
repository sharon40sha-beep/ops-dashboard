-- =============================================================================
-- OPS Dashboard — 0011 (Stage 1 of 2): checklist templates + trips model.
-- Covers A (edit/archive checklist items), B (multiple templates, one per asset),
-- C (trips = a shared movement of several assets), F (return-trip link).
-- D (joint movement) and E (duty_shifts) come in 0012.
--
-- Decisions applied: split delivery; migrate tasks -> trips/trip_items and keep
-- the tasks table DORMANT (RPCs dropped, table kept as backup); an asset with no
-- template yields an empty checklist (non-blocking). asset_ids is text[] (asset
-- ids are text codes, not uuid).
--
-- Depends on 0008/0009/0010. Safe to re-run. idempotent.
-- =============================================================================

set search_path = public, extensions;

-- ============================================================================
-- B: checklist templates (one template per asset)
-- ============================================================================
create table if not exists public.checklist_templates (
  id        uuid primary key default gen_random_uuid(),
  name      text not null,
  is_active boolean not null default true
);
alter table public.checklist_templates enable row level security;

alter table public.checklist_items add column if not exists template_id uuid references public.checklist_templates(id) on delete cascade;
alter table public.assets          add column if not exists checklist_template_id uuid references public.checklist_templates(id);

-- one-time: attach existing items + all assets to a single "default" template
do $$
declare v_tpl uuid;
begin
  if exists (select 1 from public.checklist_items where template_id is null) then
    select id into v_tpl from public.checklist_templates where name = 'ברירת מחדל' limit 1;
    if v_tpl is null then
      insert into public.checklist_templates (name) values ('ברירת מחדל') returning id into v_tpl;
    end if;
    update public.checklist_items set template_id = v_tpl where template_id is null;
  end if;
  update public.assets set checklist_template_id = (select id from public.checklist_templates where name = 'ברירת מחדל' limit 1)
   where checklist_template_id is null
     and exists (select 1 from public.checklist_templates where name = 'ברירת מחדל');
end $$;

alter table public.checklist_items alter column template_id set not null;

-- ============================================================================
-- C: trips + trip_items
-- ============================================================================
create table if not exists public.trips (
  id                uuid primary key default gen_random_uuid(),
  from_site_id      text not null references public.sites(id),
  to_site_id        text not null references public.sites(id),
  worker_id         uuid not null references public.employees(id),
  vehicle_id        text references public.vehicles(id),
  route_id          text references public.routes(id),
  time_window       text not null default '',
  status            text not null default 'planned' check (status in ('planned','active','completed')),
  return_of_trip_id uuid references public.trips(id),
  actual            jsonb,
  audit_log         jsonb not null default '[]'::jsonb,
  started_at        timestamptz,
  created_at        timestamptz not null default now()
);
create index if not exists idx_trips_worker_status on public.trips (worker_id, status);
create index if not exists idx_trips_status        on public.trips (status);
alter table public.trips enable row level security;

create table if not exists public.trip_items (
  id             uuid primary key default gen_random_uuid(),
  trip_id        uuid not null references public.trips(id) on delete cascade,
  asset_id       text not null references public.assets(id),
  checklist      jsonb not null default '[]'::jsonb,
  checklist_note text
);
create index if not exists idx_trip_items_trip on public.trip_items (trip_id);
alter table public.trip_items enable row level security;
-- both closed: reachable only via the SECURITY DEFINER RPCs below.

-- ----------------------------------------------------------------------------
-- Migrate existing tasks -> trips/trip_items (one task = one single-asset trip).
-- Runs once (only if trips is empty). Legacy free-text vehicle/route codes are
-- imported into the vehicles/routes tables first so the FKs hold.
-- ----------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.tasks') is not null and not exists (select 1 from public.trips) then
    insert into public.vehicles (id)
      select distinct nullif(btrim(vehicle), '') from public.tasks where nullif(btrim(vehicle), '') is not null
      on conflict (id) do nothing;
    insert into public.routes (id)
      select distinct nullif(btrim(route), '') from public.tasks where nullif(btrim(route), '') is not null
      on conflict (id) do nothing;

    insert into public.trips (id, from_site_id, to_site_id, worker_id, vehicle_id, route_id, time_window, status, actual, audit_log, started_at, created_at)
      select t.id, t.from_site_id, t.to_site_id, t.worker_id,
             nullif(btrim(t.vehicle), ''), nullif(btrim(t.route), ''),
             t.time_window, t.status, t.actual, t.audit_log, t.started_at, t.created_at
      from public.tasks t;

    insert into public.trip_items (trip_id, asset_id, checklist, checklist_note)
      select t.id, t.asset_id, t.checklist, null from public.tasks t;
  end if;
end $$;

-- retire the old task RPCs (tasks table kept dormant as backup)
drop function if exists public.list_my_tasks(text);
drop function if exists public.list_all_tasks(text);
drop function if exists public.list_task_history(text);
drop function if exists public.create_task(text, text, text, text, uuid, text, text, text);
drop function if exists public.update_task_checklist(text, uuid, jsonb);
drop function if exists public.start_task(text, uuid, text);
drop function if exists public.complete_task(text, uuid, jsonb);

-- ============================================================================
-- B RPCs: templates + template-scoped items + asset template assignment
-- ============================================================================
create or replace function public.admin_list_templates(session_token text)
returns setof public.checklist_templates
language plpgsql stable security definer set search_path = public
as $$
begin
  perform public._session_admin(session_token);
  return query select * from public.checklist_templates order by is_active desc, name;
end;
$$;

create or replace function public.admin_add_template(session_token text, name text)
returns void language plpgsql volatile security definer set search_path = public
as $$
begin
  perform public._session_admin(session_token);
  if coalesce(btrim(name), '') = '' then raise exception 'name required' using errcode = '22023'; end if;
  insert into public.checklist_templates (name) values (btrim(admin_add_template.name));
end;
$$;

create or replace function public.admin_update_template(session_token text, id uuid, name text, is_active boolean)
returns void language plpgsql volatile security definer set search_path = public
as $$
begin
  perform public._session_admin(session_token);
  update public.checklist_templates t
     set name = coalesce(nullif(btrim(admin_update_template.name), ''), t.name),
         is_active = coalesce(admin_update_template.is_active, t.is_active)
   where t.id = admin_update_template.id;
  if not found then raise exception 'template not found' using errcode = 'P0002'; end if;
end;
$$;

-- items are now scoped to a template (signatures change -> drop first)
drop function if exists public.admin_list_checklist_items(text);
drop function if exists public.admin_add_checklist_item(text, text, boolean, integer);

create function public.admin_list_checklist_items(session_token text, template_id uuid)
returns setof public.checklist_items
language plpgsql stable security definer set search_path = public
as $$
begin
  perform public._session_admin(session_token);
  return query select * from public.checklist_items ci
    where ci.template_id = admin_list_checklist_items.template_id
    order by ci.sort_order, ci.label;
end;
$$;

create function public.admin_add_checklist_item(session_token text, template_id uuid, label text, critical boolean, sort_order integer)
returns void language plpgsql volatile security definer set search_path = public
as $$
begin
  perform public._session_admin(session_token);
  if coalesce(btrim(label), '') = '' then raise exception 'label required' using errcode = '22023'; end if;
  insert into public.checklist_items (template_id, label, critical, sort_order, is_active)
  values (admin_add_checklist_item.template_id, btrim(admin_add_checklist_item.label),
          coalesce(admin_add_checklist_item.critical, false), coalesce(admin_add_checklist_item.sort_order, 0), true);
end;
$$;
-- admin_update_checklist_item(session_token, id, label, critical, sort_order, is_active)
-- is unchanged from 0010 (covers A: edit + archive).

-- assets gain a template assignment (signatures change -> drop first)
drop function if exists public.admin_list_assets(text);
drop function if exists public.admin_add_asset(text, text, text);
drop function if exists public.admin_update_asset(text, text, text, boolean);

create function public.admin_list_assets(session_token text)
returns table (id text, home_site_id text, is_active boolean, checklist_template_id uuid)
language plpgsql stable security definer set search_path = public
as $$
begin
  perform public._session_admin(session_token);
  return query select a.id, a.home_site_id, a.is_active, a.checklist_template_id from public.assets a order by a.id;
end;
$$;

create function public.admin_add_asset(session_token text, id text, home_site_id text, checklist_template_id uuid)
returns void language plpgsql volatile security definer set search_path = public
as $$
begin
  perform public._session_admin(session_token);
  if coalesce(btrim(admin_add_asset.id), '') = '' then raise exception 'code required' using errcode = '22023'; end if;
  insert into public.assets (id, home_site_id, is_active, checklist_template_id)
  values (btrim(admin_add_asset.id), admin_add_asset.home_site_id, true, admin_add_asset.checklist_template_id);
end;
$$;

create function public.admin_update_asset(session_token text, id text, home_site_id text, is_active boolean, checklist_template_id uuid)
returns void language plpgsql volatile security definer set search_path = public
as $$
begin
  perform public._session_admin(session_token);
  update public.assets a
     set home_site_id = coalesce(admin_update_asset.home_site_id, a.home_site_id),
         is_active = coalesce(admin_update_asset.is_active, a.is_active),
         checklist_template_id = admin_update_asset.checklist_template_id
   where a.id = admin_update_asset.id;
  if not found then raise exception 'asset not found' using errcode = 'P0002'; end if;
end;
$$;

-- ============================================================================
-- C RPCs: trips lifecycle (return trips WITH nested items as jsonb)
-- ============================================================================

-- helper-free: build a trip json object with its items
create or replace function public.create_trip(
  session_token     text,
  from_site_id      text,
  to_site_id        text,
  worker_id         uuid,
  vehicle_id        text,
  route_id          text,
  time_window       text,
  asset_ids         text[],
  return_of_trip_id uuid
)
returns jsonb
language plpgsql volatile security definer set search_path = public
as $$
declare v_trip public.trips; v_asset text; v_tpl uuid; v_checklist jsonb;
begin
  perform public._session_admin(session_token);
  if asset_ids is null or array_length(asset_ids, 1) is null then
    raise exception 'at least one asset required' using errcode = '22023';
  end if;

  insert into public.trips (from_site_id, to_site_id, worker_id, vehicle_id, route_id, time_window, status, return_of_trip_id, audit_log)
  values (create_trip.from_site_id, create_trip.to_site_id, create_trip.worker_id,
          nullif(create_trip.vehicle_id, ''), nullif(create_trip.route_id, ''), coalesce(create_trip.time_window, ''),
          'planned', create_trip.return_of_trip_id,
          jsonb_build_array(to_char(now(), 'HH24:MI') || ' – Trip created'))
  returning * into v_trip;

  foreach v_asset in array asset_ids loop
    select a.checklist_template_id into v_tpl from public.assets a where a.id = v_asset;
    select coalesce(
             jsonb_agg(jsonb_build_object('label', ci.label, 'critical', ci.critical, 'checked', false)
                       order by ci.sort_order, ci.label), '[]'::jsonb)
      into v_checklist
      from public.checklist_items ci
     where ci.template_id = v_tpl and ci.is_active = true;
    insert into public.trip_items (trip_id, asset_id, checklist, checklist_note)
    values (v_trip.id, v_asset, coalesce(v_checklist, '[]'::jsonb), null);
  end loop;

  return (
    select to_jsonb(t) || jsonb_build_object('items',
             coalesce((select jsonb_agg(to_jsonb(ti) order by ti.asset_id) from public.trip_items ti where ti.trip_id = t.id), '[]'::jsonb))
    from public.trips t where t.id = v_trip.id
  );
end;
$$;

create or replace function public.update_trip_item_checklist(session_token text, trip_item_id uuid, p_checklist jsonb, p_note text)
returns void
language plpgsql volatile security definer set search_path = public
as $$
declare v_id uuid; v_item public.trip_items; v_trip public.trips;
begin
  v_id := public._session_employee(session_token);
  select * into v_item from public.trip_items where id = trip_item_id;
  if not found then raise exception 'item not found' using errcode = 'P0002'; end if;
  select * into v_trip from public.trips where id = v_item.trip_id;
  if v_trip.worker_id <> v_id then raise exception 'not your trip' using errcode = '42501'; end if;
  if v_trip.status <> 'planned' then raise exception 'trip is not editable' using errcode = '22023'; end if;
  update public.trip_items set checklist = p_checklist, checklist_note = p_note where id = trip_item_id;
end;
$$;

create or replace function public.start_trip(session_token text, trip_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = public
as $$
declare v_id uuid; v_trip public.trips; v_bad integer;
begin
  v_id := public._session_employee(session_token);
  select * into v_trip from public.trips where id = trip_id;
  if not found then raise exception 'trip not found' using errcode = 'P0002'; end if;
  if v_trip.worker_id <> v_id then raise exception 'not your trip' using errcode = '42501'; end if;
  if v_trip.status <> 'planned' then raise exception 'trip is not planned' using errcode = '22023'; end if;

  select count(*) into v_bad
  from public.trip_items ti
  where ti.trip_id = trip_id
    and exists (select 1 from jsonb_array_elements(ti.checklist) el where coalesce((el->>'checked')::boolean, false) = false)
    and coalesce(btrim(ti.checklist_note), '') = '';
  if v_bad > 0 then
    raise exception 'skip note required' using errcode = '22023';
  end if;

  update public.trips
     set status = 'active', started_at = now(),
         audit_log = v_trip.audit_log || jsonb_build_array(to_char(now(), 'HH24:MI') || ' – Trip started')
   where id = trip_id;
  return (select to_jsonb(t) from public.trips t where t.id = trip_id);
end;
$$;

create or replace function public.complete_trip(session_token text, trip_id uuid, p_actual jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = public
as $$
declare v_id uuid; v_trip public.trips; v_dev boolean; v_actual jsonb;
begin
  v_id := public._session_employee(session_token);
  select * into v_trip from public.trips where id = trip_id;
  if not found then raise exception 'trip not found' using errcode = 'P0002'; end if;
  if v_trip.worker_id <> v_id then raise exception 'not your trip' using errcode = '42501'; end if;
  if v_trip.status <> 'active' then raise exception 'trip is not active' using errcode = '22023'; end if;

  v_dev := coalesce(btrim(p_actual->>'vehicle'), '') <> coalesce(v_trip.vehicle_id, '')
        or coalesce(btrim(p_actual->>'route'),   '') <> coalesce(v_trip.route_id,   '');
  if v_dev and coalesce(btrim(p_actual->>'reason'), '') = '' then
    raise exception 'deviation reason required' using errcode = '22023';
  end if;
  v_actual := jsonb_build_object(
    'vehicle',      coalesce(btrim(p_actual->>'vehicle'), ''),
    'route',        coalesce(btrim(p_actual->>'route'), ''),
    'completed_at', now(),
    'deviated',     v_dev,
    'reason',       case when v_dev then btrim(p_actual->>'reason') else '' end
  );
  update public.trips
     set status = 'completed', actual = v_actual,
         audit_log = v_trip.audit_log || jsonb_build_array(
           to_char(now(), 'HH24:MI') || case when v_dev then ' – Trip completed (deviation logged)' else ' – Trip completed' end)
   where id = trip_id;
  return (select to_jsonb(t) from public.trips t where t.id = trip_id);
end;
$$;

-- lists (trip + nested items)
create or replace function public.list_my_trips(session_token text)
returns jsonb language plpgsql stable security definer set search_path = public
as $$
declare v_id uuid; v_out jsonb;
begin
  v_id := public._session_employee(session_token);
  select coalesce(jsonb_agg(obj order by created_at desc), '[]'::jsonb) into v_out
  from (
    select tr.created_at,
           to_jsonb(tr) || jsonb_build_object('items',
             coalesce((select jsonb_agg(to_jsonb(ti) order by ti.asset_id) from public.trip_items ti where ti.trip_id = tr.id), '[]'::jsonb)) as obj
    from public.trips tr
    where tr.worker_id = v_id and tr.status <> 'completed'
  ) s;
  return v_out;
end;
$$;

create or replace function public.list_all_trips(session_token text)
returns jsonb language plpgsql stable security definer set search_path = public
as $$
declare v_out jsonb;
begin
  perform public._session_admin(session_token);
  select coalesce(jsonb_agg(obj order by created_at desc), '[]'::jsonb) into v_out
  from (
    select tr.created_at,
           to_jsonb(tr) || jsonb_build_object('items',
             coalesce((select jsonb_agg(to_jsonb(ti) order by ti.asset_id) from public.trip_items ti where ti.trip_id = tr.id), '[]'::jsonb)) as obj
    from public.trips tr
    where tr.status <> 'completed'
  ) s;
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
  select coalesce(jsonb_agg(obj order by created_at desc), '[]'::jsonb) into v_out
  from (
    select tr.created_at,
           to_jsonb(tr) || jsonb_build_object('items',
             coalesce((select jsonb_agg(to_jsonb(ti) order by ti.asset_id) from public.trip_items ti where ti.trip_id = tr.id), '[]'::jsonb)) as obj
    from public.trips tr
    where tr.status = 'completed' and (v_role = 'admin' or tr.worker_id = v_id)
  ) s;
  return v_out;
end;
$$;

-- F: candidate trips to link a return to (open, or completed today)
create or replace function public.admin_list_linkable_trips(session_token text)
returns jsonb language plpgsql stable security definer set search_path = public
as $$
declare v_out jsonb;
begin
  perform public._session_admin(session_token);
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', tr.id,
           'label', tr.from_site_id || ' ← ' || tr.to_site_id || ' · ' ||
                    coalesce((select string_agg(ti.asset_id, ',' order by ti.asset_id) from public.trip_items ti where ti.trip_id = tr.id), '') ||
                    ' · ' || to_char(tr.created_at, 'DD/MM HH24:MI')
         ) order by tr.created_at desc), '[]'::jsonb) into v_out
  from public.trips tr
  where tr.status <> 'completed' or tr.created_at::date = current_date;
  return v_out;
end;
$$;

-- ============================================================================
-- D (model part): asset summary now counts each TRIP once (not per asset-copy)
-- ============================================================================
create or replace function public.admin_asset_summary(session_token text, asset_id text, from_date date, to_date date)
returns jsonb language plpgsql stable security definer set search_path = public
as $$
declare v_json jsonb;
begin
  perform public._session_admin(session_token);
  with filt as (
    select distinct tr.*, coalesce(tr.started_at, tr.created_at) as dep
    from public.trips tr
    join public.trip_items ti on ti.trip_id = tr.id
    where ti.asset_id = admin_asset_summary.asset_id
      and tr.status = 'completed'
      and coalesce((tr.actual->>'completed_at')::timestamptz, tr.created_at)::date
          between admin_asset_summary.from_date and admin_asset_summary.to_date
  )
  select jsonb_build_object(
    'total',    (select count(*) from filt),
    'deviated', (select count(*) from filt where coalesce((actual->>'deviated')::boolean, false)),
    'hours', coalesce((select jsonb_agg(jsonb_build_object('hour', h, 'count', c) order by h)
                       from (select extract(hour from dep)::int h, count(*) c from filt group by 1) x), '[]'::jsonb),
    'by_vehicle', coalesce((select jsonb_agg(jsonb_build_object('key', k, 'count', c) order by c desc)
                       from (select coalesce(nullif(btrim(actual->>'vehicle'), ''), vehicle_id, '—') k, count(*) c from filt group by 1) x), '[]'::jsonb),
    'by_route', coalesce((select jsonb_agg(jsonb_build_object('key', k, 'count', c) order by c desc)
                       from (select coalesce(nullif(btrim(actual->>'route'), ''), route_id, '—') k, count(*) c from filt group by 1) x), '[]'::jsonb),
    'by_worker', coalesce((select jsonb_agg(jsonb_build_object('key', nm, 'count', c) order by c desc)
                       from (select e.name nm, count(*) c from filt f join public.employees e on e.id = f.worker_id group by e.name) x), '[]'::jsonb)
  ) into v_json;
  return v_json;
end;
$$;

-- ============================================================================
-- Privileges
-- ============================================================================
grant execute on function public.admin_list_templates(text)                                 to anon, authenticated;
grant execute on function public.admin_add_template(text, text)                              to anon, authenticated;
grant execute on function public.admin_update_template(text, uuid, text, boolean)            to anon, authenticated;
grant execute on function public.admin_list_checklist_items(text, uuid)                      to anon, authenticated;
grant execute on function public.admin_add_checklist_item(text, uuid, text, boolean, integer) to anon, authenticated;
grant execute on function public.admin_list_assets(text)                                     to anon, authenticated;
grant execute on function public.admin_add_asset(text, text, text, uuid)                     to anon, authenticated;
grant execute on function public.admin_update_asset(text, text, text, boolean, uuid)         to anon, authenticated;
grant execute on function public.create_trip(text, text, text, uuid, text, text, text, text[], uuid) to anon, authenticated;
grant execute on function public.update_trip_item_checklist(text, uuid, jsonb, text)         to anon, authenticated;
grant execute on function public.start_trip(text, uuid)                                      to anon, authenticated;
grant execute on function public.complete_trip(text, uuid, jsonb)                            to anon, authenticated;
grant execute on function public.list_my_trips(text)                                         to anon, authenticated;
grant execute on function public.list_all_trips(text)                                        to anon, authenticated;
grant execute on function public.list_trip_history(text)                                     to anon, authenticated;
grant execute on function public.admin_list_linkable_trips(text)                             to anon, authenticated;

-- ----------------------------------------------------------------------------
-- Verify (with valid tokens):
--   select public.list_all_trips('<admin-token>');
--   select public.create_trip('<admin-token>','S01','S07','<worker-uuid>','V-1','Blue','08:00', array['A1','A2'], null);
--   select * from public.admin_list_templates('<admin-token>');
-- ----------------------------------------------------------------------------
