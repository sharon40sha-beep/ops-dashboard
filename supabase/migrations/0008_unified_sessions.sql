-- =============================================================================
-- OPS Dashboard — Part A: unified sessions + immediate revoke on deactivation
--
--  A.1  Deactivating an employee kills all their sessions immediately.
--  A.2  Sessions exist for EVERY employee (not only admins). admin_sessions is
--       replaced by a general `sessions` table keyed by employee_id.
--  A.3  (client) session is cleared when the app goes to background / screen
--       locks; the server keeps a 12h backstop expiry. verify_pin now mints a
--       session on success and returns the token for everyone.
--
-- NOTE: numbering — 0007 was already used (fix_admin_login), so Part A is 0008.
-- Safe to re-run. idempotent.
-- =============================================================================

set search_path = public, extensions;

-- ----------------------------------------------------------------------------
-- General session store (all employees)
-- ----------------------------------------------------------------------------
create table if not exists public.sessions (
  id          uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  token       text not null unique,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default (now() + interval '12 hours')
);
create index if not exists idx_sessions_token    on public.sessions (token);
create index if not exists idx_sessions_employee on public.sessions (employee_id);

alter table public.sessions enable row level security;
-- no client policies: reachable only via SECURITY DEFINER RPCs.

-- migrate any existing admin_sessions rows, then retire the old table + fns
do $$
begin
  if to_regclass('public.admin_sessions') is not null then
    insert into public.sessions (id, employee_id, token, created_at, expires_at)
      select id, employee_id, token, created_at, expires_at from public.admin_sessions
      on conflict (token) do nothing;
  end if;
end $$;

drop function if exists public.admin_login(text);
drop function if exists public.admin_logout(text);
drop function if exists public.verify_pin(uuid, text);
drop table if exists public.admin_sessions;

-- ----------------------------------------------------------------------------
-- Session resolvers (raise if the token is missing / expired / not allowed)
-- ----------------------------------------------------------------------------
create or replace function public._session_employee(session_token text)
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare v_id uuid;
begin
  select s.employee_id into v_id
    from public.sessions s
    join public.employees e on e.id = s.employee_id
   where s.token = session_token
     and s.expires_at > now()
     and e.is_active = true;
  if v_id is null then
    raise exception 'invalid or expired session' using errcode = '42501';
  end if;
  return v_id;
end;
$$;

create or replace function public._session_admin(session_token text)
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare v_id uuid;
begin
  select s.employee_id into v_id
    from public.sessions s
    join public.employees e on e.id = s.employee_id
   where s.token = session_token
     and s.expires_at > now()
     and e.role = 'admin'
     and e.is_active = true;
  if v_id is null then
    raise exception 'invalid or expired admin session' using errcode = '42501';
  end if;
  return v_id;
end;
$$;

-- ----------------------------------------------------------------------------
-- app_logout — end one session
-- ----------------------------------------------------------------------------
create or replace function public.app_logout(session_token text)
returns void
language sql
volatile
security definer
set search_path = public
as $$
  delete from public.sessions s where s.token = session_token;
$$;

-- ----------------------------------------------------------------------------
-- verify_pin — auth + lockout + audit, now also MINTS a session and returns the
-- token (for every employee, not just admins).
-- ----------------------------------------------------------------------------
create function public.verify_pin(emp_id uuid, pin_input text)
returns table (
  id                  uuid,
  name                text,
  role                text,
  locked_until        timestamptz,
  retry_after_seconds integer,
  session_token       text
)
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare
  emp      public.employees%rowtype;
  v_failed integer;
  v_lock   timestamptz;
  v_token  text;
begin
  -- opportunistic cleanup of expired sessions (qualified -> unambiguous)
  delete from public.sessions s where s.expires_at <= now();

  select * into emp from public.employees e where e.id = emp_id;

  if not found then
    insert into public.login_attempts (employee_id, success, reason) values (null, false, 'unknown_employee');
    return;
  end if;

  if emp.is_active = false then
    insert into public.login_attempts (employee_id, success, reason) values (emp.id, false, 'inactive');
    return;
  end if;

  -- expired lock -> clear it and grant a fresh set of attempts
  if emp.locked_until is not null and emp.locked_until <= now() then
    update public.employees e set failed_attempts = 0, locked_until = null where e.id = emp.id;
    emp.failed_attempts := 0;
    emp.locked_until := null;
  end if;

  -- currently locked -> reject immediately
  if emp.locked_until is not null and emp.locked_until > now() then
    insert into public.login_attempts (employee_id, success, reason) values (emp.id, false, 'locked');
    return query select null::uuid, null::text, null::text, emp.locked_until,
                        greatest(0, ceil(extract(epoch from (emp.locked_until - now())))::int), null::text;
    return;
  end if;

  if emp.pin_hash is not null and crypt(pin_input, emp.pin_hash) = emp.pin_hash then
    update public.employees e set failed_attempts = 0, locked_until = null where e.id = emp.id;
    insert into public.login_attempts (employee_id, success, reason) values (emp.id, true, null);
    v_token := encode(gen_random_bytes(32), 'hex');
    insert into public.sessions (employee_id, token) values (emp.id, v_token);
    return query select emp.id, emp.name, emp.role, null::timestamptz, 0, v_token;
    return;
  else
    v_failed := emp.failed_attempts + 1;
    v_lock := case when v_failed >= 3 then now() + interval '30 minutes' else null end;
    update public.employees e
       set failed_attempts = v_failed,
           locked_until = coalesce(v_lock, e.locked_until)
     where e.id = emp.id;
    insert into public.login_attempts (employee_id, success, reason) values (emp.id, false, 'wrong_password');
    if v_lock is not null then
      return query select null::uuid, null::text, null::text, v_lock,
                          greatest(0, ceil(extract(epoch from (v_lock - now())))::int), null::text;
    end if;
    return;
  end if;
end;
$$;

-- ----------------------------------------------------------------------------
-- A.1 — deactivating an employee kills their sessions immediately.
-- (Recreated to add the session-purge; keeps the last-active-admin guard.)
-- ----------------------------------------------------------------------------
create or replace function public.admin_set_active(session_token text, target_id uuid, new_active boolean)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  perform public._session_admin(session_token);
  update public.employees set is_active = new_active where id = target_id;
  if not found then
    raise exception 'employee not found' using errcode = 'P0002';
  end if;
  if new_active = false then
    delete from public.sessions s where s.employee_id = target_id; -- immediate disconnect
  end if;
  if not exists (select 1 from public.employees where role = 'admin' and is_active = true) then
    raise exception 'cannot deactivate the last active admin' using errcode = '23514';
  end if;
end;
$$;

-- ----------------------------------------------------------------------------
-- Privileges
-- ----------------------------------------------------------------------------
revoke all on function public._session_employee(text) from public;
revoke all on function public._session_admin(text)    from public;

grant execute on function public.verify_pin(uuid, text) to anon, authenticated;
grant execute on function public.app_logout(text)       to anon, authenticated;

-- ----------------------------------------------------------------------------
-- Verify:
--   select * from public.verify_pin('00000000-0000-0000-0000-000000000001','<pw>'); -- row incl. session_token
--   select * from public.sessions;   -- a row per active login
-- ----------------------------------------------------------------------------
