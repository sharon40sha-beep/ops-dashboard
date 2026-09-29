-- =============================================================================
-- OPS Dashboard — 0012 (Stage 2 of 2): joint-movement analysis + duty shifts.
--   D  admin_joint_movement_summary — for each asset pair, shared-trip counts.
--   E  duty_types + duty_shifts: static shifts NOT tied to a specific trip
--      (night guard, camera sweep, ...). Full lifecycle RPCs + admin_duty_summary.
--
-- Depends on 0011 (trips, checklist_templates, _session_* helpers).
-- Safe to re-run. idempotent.
-- =============================================================================

set search_path = public, extensions;

-- ============================================================================
-- D: joint movement (each asset pair, shared completed trips in a range)
-- ============================================================================
create or replace function public.admin_joint_movement_summary(session_token text, from_date date, to_date date)
returns jsonb language plpgsql stable security definer set search_path = public
as $$
declare v_out jsonb;
begin
  perform public._session_admin(session_token);
  with tf as (
    select tr.id
    from public.trips tr
    where tr.status = 'completed'
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
    'a', p.a_id, 'b', p.b_id, 'joint', p.joint,
    'total_a', ta.c, 'total_b', tb.c,
    'pct_a', round(100.0 * p.joint / nullif(ta.c, 0)),
    'pct_b', round(100.0 * p.joint / nullif(tb.c, 0))
  ) order by p.joint desc), '[]'::jsonb) into v_out
  from pairs p
  join totals ta on ta.asset_id = p.a_id
  join totals tb on tb.asset_id = p.b_id;
  return v_out;
end;
$$;

-- ============================================================================
-- E: duty types + duty shifts
-- ============================================================================
create table if not exists public.duty_types (
  id                    uuid primary key default gen_random_uuid(),
  label                 text not null,
  checklist_template_id uuid references public.checklist_templates(id),
  is_active             boolean not null default true
);
alter table public.duty_types enable row level security;

create table if not exists public.duty_shifts (
  id             uuid primary key default gen_random_uuid(),
  site_id        text not null references public.sites(id),
  worker_id      uuid not null references public.employees(id),
  duty_type_id   uuid not null references public.duty_types(id),
  start_time     timestamptz not null,
  end_time       timestamptz not null,
  status         text not null default 'planned' check (status in ('planned','active','completed')),
  checklist      jsonb not null default '[]'::jsonb,
  checklist_note text,
  actual         jsonb,   -- {actual_start, actual_end, anomaly_found, anomaly_notes, completed_at}
  audit_log      jsonb not null default '[]'::jsonb,
  created_at     timestamptz not null default now()
);
create index if not exists idx_duty_shifts_worker_status on public.duty_shifts (worker_id, status);
create index if not exists idx_duty_shifts_status        on public.duty_shifts (status);
create index if not exists idx_duty_shifts_site          on public.duty_shifts (site_id);
alter table public.duty_shifts enable row level security;

-- seed a few common duty types once (general activity descriptions, not asset names)
insert into public.duty_types (label, is_active)
select v.label, true from (values
  ('שמירת כניסה/יציאה'), ('סריקת מצלמות'), ('שמירת לילה'), ('חיפוש חריגים'), ('אחר')
) as v(label)
where not exists (select 1 from public.duty_types);

-- ---- duty type admin ----
create or replace function public.admin_list_duty_types(session_token text)
returns setof public.duty_types
language plpgsql stable security definer set search_path = public
as $$
begin
  perform public._session_admin(session_token);
  return query select * from public.duty_types order by is_active desc, label;
end;
$$;

create or replace function public.admin_add_duty_type(session_token text, label text, checklist_template_id uuid)
returns void language plpgsql volatile security definer set search_path = public
as $$
begin
  perform public._session_admin(session_token);
  if coalesce(btrim(label), '') = '' then raise exception 'label required' using errcode = '22023'; end if;
  insert into public.duty_types (label, checklist_template_id, is_active)
  values (btrim(admin_add_duty_type.label), admin_add_duty_type.checklist_template_id, true);
end;
$$;

create or replace function public.admin_update_duty_type(session_token text, id uuid, label text, checklist_template_id uuid, is_active boolean)
returns void language plpgsql volatile security definer set search_path = public
as $$
begin
  perform public._session_admin(session_token);
  update public.duty_types dt
     set label = coalesce(nullif(btrim(admin_update_duty_type.label), ''), dt.label),
         checklist_template_id = admin_update_duty_type.checklist_template_id,
         is_active = coalesce(admin_update_duty_type.is_active, dt.is_active)
   where dt.id = admin_update_duty_type.id;
  if not found then raise exception 'duty type not found' using errcode = 'P0002'; end if;
end;
$$;

-- ---- duty shift lifecycle ----
create or replace function public.create_duty_shift(
  session_token text, site_id text, worker_id uuid, duty_type_id uuid, start_time timestamptz, end_time timestamptz)
returns jsonb language plpgsql volatile security definer set search_path = public
as $$
declare v_shift public.duty_shifts; v_tpl uuid; v_checklist jsonb;
begin
  perform public._session_admin(session_token);
  select dt.checklist_template_id into v_tpl from public.duty_types dt where dt.id = create_duty_shift.duty_type_id;
  select coalesce(jsonb_agg(jsonb_build_object('label', ci.label, 'critical', ci.critical, 'checked', false)
                            order by ci.sort_order, ci.label), '[]'::jsonb)
    into v_checklist
    from public.checklist_items ci where ci.template_id = v_tpl and ci.is_active = true;

  insert into public.duty_shifts (site_id, worker_id, duty_type_id, start_time, end_time, status, checklist, audit_log)
  values (create_duty_shift.site_id, create_duty_shift.worker_id, create_duty_shift.duty_type_id,
          create_duty_shift.start_time, create_duty_shift.end_time, 'planned',
          coalesce(v_checklist, '[]'::jsonb),
          jsonb_build_array(to_char(now(), 'HH24:MI') || ' – Shift created'))
  returning * into v_shift;

  return (select to_jsonb(d) || jsonb_build_object('duty_type_label', dt.label)
          from public.duty_shifts d join public.duty_types dt on dt.id = d.duty_type_id where d.id = v_shift.id);
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
  if v_shift.worker_id <> v_id then raise exception 'not your shift' using errcode = '42501'; end if;
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
  if v_shift.worker_id <> v_id then raise exception 'not your shift' using errcode = '42501'; end if;
  if v_shift.status <> 'planned' then raise exception 'shift is not planned' using errcode = '22023'; end if;

  v_unchecked := exists (select 1 from jsonb_array_elements(v_shift.checklist) el where coalesce((el->>'checked')::boolean, false) = false);
  if v_unchecked and coalesce(btrim(v_shift.checklist_note), '') = '' then
    raise exception 'skip note required' using errcode = '22023';
  end if;

  update public.duty_shifts set status = 'active',
    audit_log = v_shift.audit_log || jsonb_build_array(to_char(now(), 'HH24:MI') || ' – Shift started')
   where id = duty_shift_id;
  return (select to_jsonb(d) || jsonb_build_object('duty_type_label', dt.label)
          from public.duty_shifts d join public.duty_types dt on dt.id = d.duty_type_id where d.id = duty_shift_id);
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
  if v_shift.worker_id <> v_id then raise exception 'not your shift' using errcode = '42501'; end if;
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
  return (select to_jsonb(d) || jsonb_build_object('duty_type_label', dt.label)
          from public.duty_shifts d join public.duty_types dt on dt.id = d.duty_type_id where d.id = duty_shift_id);
end;
$$;

-- ---- duty lists (shift + duty_type_label) ----
create or replace function public.list_my_duties(session_token text)
returns jsonb language plpgsql stable security definer set search_path = public
as $$
declare v_id uuid; v_out jsonb;
begin
  v_id := public._session_employee(session_token);
  select coalesce(jsonb_agg(obj order by created_at desc), '[]'::jsonb) into v_out
  from (select ds.created_at, to_jsonb(ds) || jsonb_build_object('duty_type_label', dt.label) as obj
        from public.duty_shifts ds join public.duty_types dt on dt.id = ds.duty_type_id
        where ds.worker_id = v_id and ds.status <> 'completed') s;
  return v_out;
end;
$$;

create or replace function public.list_all_duties(session_token text)
returns jsonb language plpgsql stable security definer set search_path = public
as $$
declare v_out jsonb;
begin
  perform public._session_admin(session_token);
  select coalesce(jsonb_agg(obj order by created_at desc), '[]'::jsonb) into v_out
  from (select ds.created_at, to_jsonb(ds) || jsonb_build_object('duty_type_label', dt.label) as obj
        from public.duty_shifts ds join public.duty_types dt on dt.id = ds.duty_type_id
        where ds.status <> 'completed') s;
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
  select coalesce(jsonb_agg(obj order by created_at desc), '[]'::jsonb) into v_out
  from (select ds.created_at, to_jsonb(ds) || jsonb_build_object('duty_type_label', dt.label) as obj
        from public.duty_shifts ds join public.duty_types dt on dt.id = ds.duty_type_id
        where ds.status = 'completed' and (v_role = 'admin' or ds.worker_id = v_id)) s;
  return v_out;
end;
$$;

-- ---- duty summary per site ----
create or replace function public.admin_duty_summary(session_token text, site_id text, from_date date, to_date date)
returns jsonb language plpgsql stable security definer set search_path = public
as $$
declare v_out jsonb;
begin
  perform public._session_admin(session_token);
  with filt as (
    select ds.*
    from public.duty_shifts ds
    where ds.site_id = admin_duty_summary.site_id and ds.status = 'completed'
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
grant execute on function public.admin_joint_movement_summary(text, date, date)                  to anon, authenticated;
grant execute on function public.admin_list_duty_types(text)                                      to anon, authenticated;
grant execute on function public.admin_add_duty_type(text, text, uuid)                            to anon, authenticated;
grant execute on function public.admin_update_duty_type(text, uuid, text, uuid, boolean)          to anon, authenticated;
grant execute on function public.create_duty_shift(text, text, uuid, uuid, timestamptz, timestamptz) to anon, authenticated;
grant execute on function public.update_duty_checklist(text, uuid, jsonb, text)                   to anon, authenticated;
grant execute on function public.start_duty(text, uuid)                                           to anon, authenticated;
grant execute on function public.complete_duty(text, uuid, jsonb)                                 to anon, authenticated;
grant execute on function public.list_my_duties(text)                                             to anon, authenticated;
grant execute on function public.list_all_duties(text)                                            to anon, authenticated;
grant execute on function public.list_duty_history(text)                                          to anon, authenticated;
grant execute on function public.admin_duty_summary(text, text, date, date)                       to anon, authenticated;

-- ----------------------------------------------------------------------------
-- Verify (with valid tokens):
--   select public.admin_joint_movement_summary('<admin>', current_date-30, current_date);
--   select public.list_all_duties('<admin>');
--   select * from public.admin_list_duty_types('<admin>');
-- ----------------------------------------------------------------------------
