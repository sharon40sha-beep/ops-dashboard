-- =============================================================================
-- OPS Dashboard — Part B: close direct access to tasks; everything via RPCs
--
-- tasks was directly readable/writable with the anon key. Now it is fully
-- closed (same pattern as employees): RLS on, no client policies, no table
-- grants — reachable ONLY through the SECURITY DEFINER RPCs below, each of which
-- validates a session_token (from Part A) and enforces per-user ownership.
--
-- ⚠️ Realtime on tasks stops delivering to anon once SELECT is closed (Realtime
--    honors RLS). The client switches to refetch-on-focus + light polling.
--
-- Depends on 0008 (sessions + _session_employee / _session_admin).
-- Safe to re-run. idempotent.
-- =============================================================================

set search_path = public, extensions;

-- ----------------------------------------------------------------------------
-- Close the table
-- ----------------------------------------------------------------------------
drop policy if exists tasks_select on public.tasks;
drop policy if exists tasks_insert on public.tasks;
drop policy if exists tasks_update on public.tasks;
revoke select, insert, update, delete on public.tasks from anon, authenticated;
-- RLS stays enabled with zero policies => no direct client access at all.

-- ----------------------------------------------------------------------------
-- Reads
-- ----------------------------------------------------------------------------

-- open (non-completed) tasks of the logged-in employee
create or replace function public.list_my_tasks(session_token text)
returns setof public.tasks
language plpgsql
stable
security definer
set search_path = public
as $$
declare v_id uuid;
begin
  v_id := public._session_employee(session_token);
  return query
    select * from public.tasks t
     where t.worker_id = v_id and t.status <> 'completed'
     order by t.created_at desc;
end;
$$;

-- open tasks of everyone — admins only
create or replace function public.list_all_tasks(session_token text)
returns setof public.tasks
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public._session_admin(session_token);
  return query
    select * from public.tasks t
     where t.status <> 'completed'
     order by t.created_at desc;
end;
$$;

-- completed tasks: admin sees all, operator sees own
create or replace function public.list_task_history(session_token text)
returns setof public.tasks
language plpgsql
stable
security definer
set search_path = public
as $$
declare v_id uuid; v_role text;
begin
  v_id := public._session_employee(session_token);
  select role into v_role from public.employees where id = v_id;
  if v_role = 'admin' then
    return query select * from public.tasks t where t.status = 'completed' order by t.created_at desc;
  else
    return query select * from public.tasks t where t.status = 'completed' and t.worker_id = v_id order by t.created_at desc;
  end if;
end;
$$;

-- ----------------------------------------------------------------------------
-- Writes
-- ----------------------------------------------------------------------------

-- create a task — admins only
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
declare v_task public.tasks;
begin
  perform public._session_admin(session_token);
  insert into public.tasks
    (asset_id, from_site_id, to_site_id, worker_id, vehicle, route, time_window, status, checklist, actual, audit_log)
  values
    (create_task.asset_id, create_task.from_site_id, create_task.to_site_id, create_task.worker_id,
     coalesce(create_task.vehicle, ''), coalesce(create_task.route, ''), coalesce(create_task.time_window, ''),
     'planned',
     '[{"label":"בוצעה תצפית","checked":false},
        {"label":"לא זוהו חריגים","checked":false},
        {"label":"סביבת היציאה נבדקה","checked":false},
        {"label":"הרכב מוכן","checked":false},
        {"label":"תקשורת תקינה","checked":false}]'::jsonb,
     null,
     jsonb_build_array(to_char(now(), 'HH24:MI') || ' – Task created'))
  returning * into v_task;
  return v_task;
end;
$$;

-- update the checklist — only the owner, only while planned
create or replace function public.update_task_checklist(session_token text, task_id uuid, p_checklist jsonb)
returns public.tasks
language plpgsql
volatile
security definer
set search_path = public
as $$
declare v_id uuid; v_task public.tasks;
begin
  v_id := public._session_employee(session_token);
  select * into v_task from public.tasks t where t.id = task_id;
  if not found then raise exception 'task not found' using errcode = 'P0002'; end if;
  if v_task.worker_id <> v_id then raise exception 'not your task' using errcode = '42501'; end if;
  if v_task.status <> 'planned' then raise exception 'task is not editable' using errcode = '22023'; end if;
  update public.tasks t set checklist = p_checklist where t.id = task_id returning * into v_task;
  return v_task;
end;
$$;

-- start a task — only the owner, only when the checklist is fully checked
create or replace function public.start_task(session_token text, task_id uuid)
returns public.tasks
language plpgsql
volatile
security definer
set search_path = public
as $$
declare v_id uuid; v_task public.tasks;
begin
  v_id := public._session_employee(session_token);
  select * into v_task from public.tasks t where t.id = task_id;
  if not found then raise exception 'task not found' using errcode = 'P0002'; end if;
  if v_task.worker_id <> v_id then raise exception 'not your task' using errcode = '42501'; end if;
  if v_task.status <> 'planned' then raise exception 'task is not in planned state' using errcode = '22023'; end if;
  if jsonb_typeof(v_task.checklist) <> 'array'
     or jsonb_array_length(v_task.checklist) = 0
     or exists (select 1 from jsonb_array_elements(v_task.checklist) el
                where coalesce((el->>'checked')::boolean, false) = false) then
    raise exception 'checklist incomplete' using errcode = '22023';
  end if;
  update public.tasks t
     set status = 'active',
         audit_log = v_task.audit_log || jsonb_build_array(to_char(now(), 'HH24:MI') || ' – Task started')
   where t.id = task_id
   returning * into v_task;
  return v_task;
end;
$$;

-- complete a task — only the owner; server computes deviation and completed_at
create or replace function public.complete_task(session_token text, task_id uuid, p_actual jsonb)
returns public.tasks
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_id     uuid;
  v_task   public.tasks;
  v_dev    boolean;
  v_actual jsonb;
begin
  v_id := public._session_employee(session_token);
  select * into v_task from public.tasks t where t.id = task_id;
  if not found then raise exception 'task not found' using errcode = 'P0002'; end if;
  if v_task.worker_id <> v_id then raise exception 'not your task' using errcode = '42501'; end if;
  if v_task.status <> 'active' then raise exception 'task is not active' using errcode = '22023'; end if;

  v_dev := coalesce(btrim(p_actual->>'vehicle'), '') <> coalesce(btrim(v_task.vehicle), '')
        or coalesce(btrim(p_actual->>'route'),   '') <> coalesce(btrim(v_task.route),   '');

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

  update public.tasks t
     set status = 'completed',
         actual = v_actual,
         audit_log = v_task.audit_log || jsonb_build_array(
           to_char(now(), 'HH24:MI') ||
           case when v_dev then ' – Task completed (deviation logged)' else ' – Task completed' end)
   where t.id = task_id
   returning * into v_task;
  return v_task;
end;
$$;

-- ----------------------------------------------------------------------------
-- Privileges
-- ----------------------------------------------------------------------------
grant execute on function public.list_my_tasks(text)                                              to anon, authenticated;
grant execute on function public.list_all_tasks(text)                                             to anon, authenticated;
grant execute on function public.list_task_history(text)                                          to anon, authenticated;
grant execute on function public.create_task(text, text, text, text, uuid, text, text, text)      to anon, authenticated;
grant execute on function public.update_task_checklist(text, uuid, jsonb)                         to anon, authenticated;
grant execute on function public.start_task(text, uuid)                                           to anon, authenticated;
grant execute on function public.complete_task(text, uuid, jsonb)                                 to anon, authenticated;

-- ----------------------------------------------------------------------------
-- Verify (with a valid session_token from verify_pin):
--   select * from public.list_my_tasks('<token>');
--   select * from public.tasks;   -- as anon: should now be DENIED
-- ----------------------------------------------------------------------------
