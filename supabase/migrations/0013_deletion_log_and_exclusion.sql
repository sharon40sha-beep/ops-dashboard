-- =============================================================================
-- OPS Dashboard — 0013: hard delete with a permanent audit trail (A) +
-- reversible "exclude from analysis" flag (B).
--
--  A  deletion_log (insert-only, forever — no update/delete policy for anyone).
--     Admin delete RPCs require step-up (fresh password) + a reason, snapshot
--     the row into the log, then delete. Entities still referenced by history
--     are blocked by the FK and return a clear "archive instead" error.
--  B  trips/duty_shifts gain excluded_from_analysis + excluded_reason. Reversible,
--     non-destructive: the record stays in history (with a visible tag) but is
--     filtered out of every analytics function.
--
-- Depends on 0008–0012. Safe to re-run. idempotent.
-- =============================================================================

set search_path = public, extensions;

-- ============================================================================
-- A: permanent deletion log + delete RPCs
-- ============================================================================

-- entity_id is TEXT (trip/duty/item ids are uuid; asset/site/route/vehicle ids
-- are text codes) — stored as text so one column fits all. The full row is kept
-- in entity_snapshot regardless.
create table if not exists public.deletion_log (
  id              uuid primary key default gen_random_uuid(),
  entity_type     text not null,
  entity_id       text,
  entity_snapshot jsonb,
  deleted_by      uuid references public.employees(id),
  deleted_at      timestamptz not null default now(),
  reason          text
);
alter table public.deletion_log enable row level security;
-- DELIBERATELY no policies and no grants: the table is unreachable directly by
-- any client, and NO update/delete RPC exists — it is append-only forever.
-- Only the SECURITY DEFINER RPCs below (running as owner) write/read it.

create or replace function public._log_deletion(p_type text, p_id text, p_snap jsonb, p_by uuid, p_reason text)
returns void language plpgsql volatile security definer set search_path = public
as $$
begin
  insert into public.deletion_log (entity_type, entity_id, entity_snapshot, deleted_by, reason)
  values (p_type, p_id, p_snap, p_by, btrim(p_reason));
end;
$$;
revoke all on function public._log_deletion(text, text, jsonb, uuid, text) from public;

-- ---- trips (cascades trip_items) ----
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
  v_snap := to_jsonb(v_trip) || jsonb_build_object('items',
              coalesce((select jsonb_agg(to_jsonb(ti)) from public.trip_items ti where ti.trip_id = v_trip.id), '[]'::jsonb));
  perform public._log_deletion('trip', v_trip.id::text, v_snap, v_admin, reason);
  delete from public.trips where id = trip_id;
end;
$$;

-- ---- duty shifts ----
create or replace function public.admin_delete_duty_shift(session_token text, actor_pin text, duty_shift_id uuid, reason text)
returns void language plpgsql volatile security definer set search_path = public, extensions
as $$
declare v_admin uuid; v_row public.duty_shifts;
begin
  v_admin := public._session_admin(session_token);
  perform public._assert_step_up(v_admin, actor_pin);
  if coalesce(btrim(reason), '') = '' then raise exception 'reason required' using errcode = '22023'; end if;
  select * into v_row from public.duty_shifts where id = duty_shift_id;
  if not found then raise exception 'shift not found' using errcode = 'P0002'; end if;
  perform public._log_deletion('duty_shift', v_row.id::text, to_jsonb(v_row), v_admin, reason);
  delete from public.duty_shifts where id = duty_shift_id;
end;
$$;

-- ---- reference entities (FK-protected: blocked if referenced by history) ----
create or replace function public.admin_delete_asset(session_token text, actor_pin text, id text, reason text)
returns void language plpgsql volatile security definer set search_path = public, extensions
as $$
declare v_admin uuid; v_row public.assets;
begin
  v_admin := public._session_admin(session_token);
  perform public._assert_step_up(v_admin, actor_pin);
  if coalesce(btrim(reason), '') = '' then raise exception 'reason required' using errcode = '22023'; end if;
  select * into v_row from public.assets a where a.id = admin_delete_asset.id;
  if not found then raise exception 'asset not found' using errcode = 'P0002'; end if;
  perform public._log_deletion('asset', v_row.id, to_jsonb(v_row), v_admin, reason);
  begin
    delete from public.assets a where a.id = admin_delete_asset.id;
  exception when foreign_key_violation then
    raise exception 'referenced by history — archive instead' using errcode = '23503';
  end;
end;
$$;

create or replace function public.admin_delete_site(session_token text, actor_pin text, id text, reason text)
returns void language plpgsql volatile security definer set search_path = public, extensions
as $$
declare v_admin uuid; v_row public.sites;
begin
  v_admin := public._session_admin(session_token);
  perform public._assert_step_up(v_admin, actor_pin);
  if coalesce(btrim(reason), '') = '' then raise exception 'reason required' using errcode = '22023'; end if;
  select * into v_row from public.sites s where s.id = admin_delete_site.id;
  if not found then raise exception 'site not found' using errcode = 'P0002'; end if;
  perform public._log_deletion('site', v_row.id, to_jsonb(v_row), v_admin, reason);
  begin
    delete from public.sites s where s.id = admin_delete_site.id;
  exception when foreign_key_violation then
    raise exception 'referenced by history — archive instead' using errcode = '23503';
  end;
end;
$$;

create or replace function public.admin_delete_route(session_token text, actor_pin text, id text, reason text)
returns void language plpgsql volatile security definer set search_path = public, extensions
as $$
declare v_admin uuid; v_row public.routes;
begin
  v_admin := public._session_admin(session_token);
  perform public._assert_step_up(v_admin, actor_pin);
  if coalesce(btrim(reason), '') = '' then raise exception 'reason required' using errcode = '22023'; end if;
  select * into v_row from public.routes r where r.id = admin_delete_route.id;
  if not found then raise exception 'route not found' using errcode = 'P0002'; end if;
  perform public._log_deletion('route', v_row.id, to_jsonb(v_row), v_admin, reason);
  begin
    delete from public.routes r where r.id = admin_delete_route.id;
  exception when foreign_key_violation then
    raise exception 'referenced by history — archive instead' using errcode = '23503';
  end;
end;
$$;

create or replace function public.admin_delete_vehicle(session_token text, actor_pin text, id text, reason text)
returns void language plpgsql volatile security definer set search_path = public, extensions
as $$
declare v_admin uuid; v_row public.vehicles;
begin
  v_admin := public._session_admin(session_token);
  perform public._assert_step_up(v_admin, actor_pin);
  if coalesce(btrim(reason), '') = '' then raise exception 'reason required' using errcode = '22023'; end if;
  select * into v_row from public.vehicles v where v.id = admin_delete_vehicle.id;
  if not found then raise exception 'vehicle not found' using errcode = 'P0002'; end if;
  perform public._log_deletion('vehicle', v_row.id, to_jsonb(v_row), v_admin, reason);
  begin
    delete from public.vehicles v where v.id = admin_delete_vehicle.id;
  exception when foreign_key_violation then
    raise exception 'referenced by history — archive instead' using errcode = '23503';
  end;
end;
$$;

-- ---- checklist item / template / duty type ----
create or replace function public.admin_delete_checklist_item(session_token text, actor_pin text, id uuid, reason text)
returns void language plpgsql volatile security definer set search_path = public, extensions
as $$
declare v_admin uuid; v_row public.checklist_items;
begin
  v_admin := public._session_admin(session_token);
  perform public._assert_step_up(v_admin, actor_pin);
  if coalesce(btrim(reason), '') = '' then raise exception 'reason required' using errcode = '22023'; end if;
  select * into v_row from public.checklist_items ci where ci.id = admin_delete_checklist_item.id;
  if not found then raise exception 'item not found' using errcode = 'P0002'; end if;
  perform public._log_deletion('checklist_item', v_row.id::text, to_jsonb(v_row), v_admin, reason);
  delete from public.checklist_items ci where ci.id = admin_delete_checklist_item.id;
end;
$$;

create or replace function public.admin_delete_checklist_template(session_token text, actor_pin text, id uuid, reason text)
returns void language plpgsql volatile security definer set search_path = public, extensions
as $$
declare v_admin uuid; v_row public.checklist_templates;
begin
  v_admin := public._session_admin(session_token);
  perform public._assert_step_up(v_admin, actor_pin);
  if coalesce(btrim(reason), '') = '' then raise exception 'reason required' using errcode = '22023'; end if;
  select * into v_row from public.checklist_templates t where t.id = admin_delete_checklist_template.id;
  if not found then raise exception 'template not found' using errcode = 'P0002'; end if;
  perform public._log_deletion('checklist_template', v_row.id::text, to_jsonb(v_row), v_admin, reason);
  begin
    delete from public.checklist_templates t where t.id = admin_delete_checklist_template.id;
  exception when foreign_key_violation then
    raise exception 'referenced by history — archive instead' using errcode = '23503';
  end;
end;
$$;

create or replace function public.admin_delete_duty_type(session_token text, actor_pin text, id uuid, reason text)
returns void language plpgsql volatile security definer set search_path = public, extensions
as $$
declare v_admin uuid; v_row public.duty_types;
begin
  v_admin := public._session_admin(session_token);
  perform public._assert_step_up(v_admin, actor_pin);
  if coalesce(btrim(reason), '') = '' then raise exception 'reason required' using errcode = '22023'; end if;
  select * into v_row from public.duty_types dt where dt.id = admin_delete_duty_type.id;
  if not found then raise exception 'duty type not found' using errcode = 'P0002'; end if;
  perform public._log_deletion('duty_type', v_row.id::text, to_jsonb(v_row), v_admin, reason);
  begin
    delete from public.duty_types dt where dt.id = admin_delete_duty_type.id;
  exception when foreign_key_violation then
    raise exception 'referenced by history — archive instead' using errcode = '23503';
  end;
end;
$$;

-- ---- read the log (view only) ----
create or replace function public.admin_list_deletion_log(session_token text, limit_count integer default 100)
returns jsonb language plpgsql stable security definer set search_path = public
as $$
declare v_out jsonb;
begin
  perform public._session_admin(session_token);
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', dl.id, 'entity_type', dl.entity_type, 'entity_id', dl.entity_id,
    'deleted_by_name', e.name, 'deleted_at', dl.deleted_at, 'reason', dl.reason,
    'snapshot', dl.entity_snapshot
  ) order by dl.deleted_at desc), '[]'::jsonb) into v_out
  from public.deletion_log dl
  left join public.employees e on e.id = dl.deleted_by
  where dl.id in (select id from public.deletion_log order by deleted_at desc limit greatest(1, least(coalesce(limit_count, 100), 500)));
  return v_out;
end;
$$;

-- ============================================================================
-- B: reversible "exclude from analysis" flag on trips + duty_shifts
-- ============================================================================
alter table public.trips       add column if not exists excluded_from_analysis boolean not null default false;
alter table public.trips       add column if not exists excluded_reason text;
alter table public.duty_shifts add column if not exists excluded_from_analysis boolean not null default false;
alter table public.duty_shifts add column if not exists excluded_reason text;

create or replace function public.admin_set_trip_analysis_exclusion(session_token text, trip_id uuid, excluded boolean, reason text)
returns void language plpgsql volatile security definer set search_path = public
as $$
declare v_trip public.trips;
begin
  perform public._session_admin(session_token);
  if excluded and coalesce(btrim(reason), '') = '' then raise exception 'reason required' using errcode = '22023'; end if;
  select * into v_trip from public.trips where id = trip_id;
  if not found then raise exception 'trip not found' using errcode = 'P0002'; end if;
  update public.trips
     set excluded_from_analysis = excluded,
         excluded_reason = case when excluded then btrim(reason) else null end,
         audit_log = v_trip.audit_log || jsonb_build_array(to_char(now(), 'HH24:MI') ||
           case when excluded then ' – Excluded from analysis: ' || btrim(reason) else ' – Re-included in analysis' end)
   where id = trip_id;
end;
$$;

create or replace function public.admin_set_duty_analysis_exclusion(session_token text, duty_shift_id uuid, excluded boolean, reason text)
returns void language plpgsql volatile security definer set search_path = public
as $$
declare v_row public.duty_shifts;
begin
  perform public._session_admin(session_token);
  if excluded and coalesce(btrim(reason), '') = '' then raise exception 'reason required' using errcode = '22023'; end if;
  select * into v_row from public.duty_shifts where id = duty_shift_id;
  if not found then raise exception 'shift not found' using errcode = 'P0002'; end if;
  update public.duty_shifts
     set excluded_from_analysis = excluded,
         excluded_reason = case when excluded then btrim(reason) else null end,
         audit_log = v_row.audit_log || jsonb_build_array(to_char(now(), 'HH24:MI') ||
           case when excluded then ' – Excluded from analysis: ' || btrim(reason) else ' – Re-included in analysis' end)
   where id = duty_shift_id;
end;
$$;

-- ============================================================================
-- Analytics: filter out excluded records (recreate 0011/0012 functions)
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
  )
  select jsonb_build_object(
    'total', (select count(*) from filt),
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

create or replace function public.admin_joint_movement_summary(session_token text, from_date date, to_date date)
returns jsonb language plpgsql stable security definer set search_path = public
as $$
declare v_out jsonb;
begin
  perform public._session_admin(session_token);
  with tf as (
    select tr.id from public.trips tr
    where tr.status = 'completed' and tr.excluded_from_analysis = false
      and coalesce((tr.actual->>'completed_at')::timestamptz, tr.created_at)::date
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
                 from (select e.name nm, count(*) c from filt f join public.employees e on e.id = f.worker_id group by e.name) x), '[]'::jsonb)
  ) into v_out;
  return v_out;
end;
$$;

-- ============================================================================
-- Privileges
-- ============================================================================
revoke all on function public._log_deletion(text, text, jsonb, uuid, text) from public;

grant execute on function public.admin_delete_trip(text, text, uuid, text)              to anon, authenticated;
grant execute on function public.admin_delete_duty_shift(text, text, uuid, text)         to anon, authenticated;
grant execute on function public.admin_delete_asset(text, text, text, text)              to anon, authenticated;
grant execute on function public.admin_delete_site(text, text, text, text)               to anon, authenticated;
grant execute on function public.admin_delete_route(text, text, text, text)              to anon, authenticated;
grant execute on function public.admin_delete_vehicle(text, text, text, text)            to anon, authenticated;
grant execute on function public.admin_delete_checklist_item(text, text, uuid, text)     to anon, authenticated;
grant execute on function public.admin_delete_checklist_template(text, text, uuid, text) to anon, authenticated;
grant execute on function public.admin_delete_duty_type(text, text, uuid, text)          to anon, authenticated;
grant execute on function public.admin_list_deletion_log(text, integer)                  to anon, authenticated;
grant execute on function public.admin_set_trip_analysis_exclusion(text, uuid, boolean, text) to anon, authenticated;
grant execute on function public.admin_set_duty_analysis_exclusion(text, uuid, boolean, text) to anon, authenticated;

-- ----------------------------------------------------------------------------
-- Verify (admin token + fresh password):
--   select public.admin_delete_route('<token>','<pw>','TESTROUTE','cleanup');
--   select public.admin_list_deletion_log('<token>', 50);
--   select public.admin_set_trip_analysis_exclusion('<token>','<trip-uuid>', true, 'demo game');
-- ----------------------------------------------------------------------------
