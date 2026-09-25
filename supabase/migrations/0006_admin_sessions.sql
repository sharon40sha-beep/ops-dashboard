-- =============================================================================
-- OPS Dashboard — admin session tokens + step-up auth + lockout display fix
--
--  1) Session-based admin auth: admin_login(pin) mints a token stored in
--     admin_sessions (12h TTL). All admin RPCs now take a session_token instead
--     of the password on every call. admin_logout(token) ends it.
--  2) Step-up: two sensitive actions (add employee, unlock account) require the
--     admin to re-enter their password (actor_pin) IN ADDITION to a valid token.
--  3) Lockout display fix: verify_pin returns retry_after_seconds computed in
--     the DB (locked_until - now()), so the client never does timezone math.
--     Also auto-resets the counter once a lock has expired.
--
-- Safe to re-run. idempotent.
-- =============================================================================

set search_path = public, extensions;

-- ----------------------------------------------------------------------------
-- Admin session store
-- ----------------------------------------------------------------------------
create table if not exists public.admin_sessions (
  id          uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  token       text not null unique,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default (now() + interval '12 hours')
);
create index if not exists idx_admin_sessions_token on public.admin_sessions (token);

alter table public.admin_sessions enable row level security;
-- no client policies: reachable only via the SECURITY DEFINER RPCs below.

-- ----------------------------------------------------------------------------
-- admin_login(pin) -> token   (verifies an active, non-locked admin)
-- ----------------------------------------------------------------------------
create or replace function public.admin_login(pin text)
returns table (token text, expires_at timestamptz)
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare
  v_emp   public.employees%rowtype;
  v_token text;
  v_exp   timestamptz;
begin
  -- tidy up expired sessions opportunistically
  delete from public.admin_sessions where expires_at <= now();

  select * into v_emp
    from public.employees e
   where e.role = 'admin'
     and e.is_active = true
     and e.pin_hash is not null
     and crypt(pin, e.pin_hash) = e.pin_hash
     and (e.locked_until is null or e.locked_until <= now())
   limit 1;

  if not found then
    return; -- invalid / locked / not an active admin
  end if;

  v_token := encode(gen_random_bytes(32), 'hex');
  v_exp   := now() + interval '12 hours';
  insert into public.admin_sessions (employee_id, token, expires_at)
  values (v_emp.id, v_token, v_exp);

  return query select v_token, v_exp;
end;
$$;

-- ----------------------------------------------------------------------------
-- admin_logout(session_token) -> void
-- ----------------------------------------------------------------------------
create or replace function public.admin_logout(session_token text)
returns void
language sql
volatile
security definer
set search_path = public
as $$
  delete from public.admin_sessions where token = session_token;
$$;

-- ----------------------------------------------------------------------------
-- Internal: resolve an admin session token -> employee_id (raises if invalid).
-- Also re-checks the holder is STILL an active admin, so deactivating/demoting
-- an admin instantly invalidates their sessions.
-- ----------------------------------------------------------------------------
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
    from public.admin_sessions s
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
-- Internal: step-up — verify a fresh password belongs to the session's admin.
-- ----------------------------------------------------------------------------
create or replace function public._assert_step_up(v_admin_id uuid, actor_pin text)
returns void
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
begin
  if actor_pin is null or not exists (
    select 1 from public.employees
    where id = v_admin_id
      and pin_hash is not null
      and crypt(actor_pin, pin_hash) = pin_hash
  ) then
    raise exception 'step-up password verification failed' using errcode = '42501';
  end if;
end;
$$;

-- ----------------------------------------------------------------------------
-- Rebuild the admin RPCs to take a session_token (drop first: return types and
-- parameter names change, which CREATE OR REPLACE cannot do).
-- ----------------------------------------------------------------------------
drop function if exists public.admin_list_employees(text);
drop function if exists public.admin_list_login_attempts(text, integer);
drop function if exists public.admin_set_pin(text, uuid, text);
drop function if exists public.admin_set_role(text, uuid, text);
drop function if exists public.admin_set_active(text, uuid, boolean);
drop function if exists public.admin_add_employee(text, text, text, text);
drop function if exists public.verify_pin(uuid, text);

-- roster incl. lock state (never the password hash)
create function public.admin_list_employees(session_token text)
returns table (id uuid, name text, role text, is_active boolean, is_locked boolean)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public._session_admin(session_token);
  return query
    select e.id, e.name, e.role, e.is_active,
           (e.locked_until is not null and e.locked_until > now()) as is_locked
    from public.employees e
    order by e.is_active desc, e.role, e.name;
end;
$$;

-- login audit
create function public.admin_list_login_attempts(session_token text, limit_count integer default 50)
returns table (
  id            uuid,
  employee_id   uuid,
  employee_name text,
  attempted_at  timestamptz,
  success       boolean,
  reason        text
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public._session_admin(session_token);
  return query
    select la.id, la.employee_id, e.name, la.attempted_at, la.success, la.reason
    from public.login_attempts la
    left join public.employees e on e.id = la.employee_id
    order by la.attempted_at desc
    limit greatest(1, least(coalesce(limit_count, 50), 500));
end;
$$;

-- change a password (token only)
create function public.admin_set_pin(session_token text, target_id uuid, new_pin text)
returns void
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
begin
  perform public._session_admin(session_token);
  if not public._valid_password(new_pin) then
    raise exception 'password does not meet policy' using errcode = '22023';
  end if;
  update public.employees set pin_hash = crypt(new_pin, gen_salt('bf')) where id = target_id;
  if not found then
    raise exception 'employee not found' using errcode = 'P0002';
  end if;
end;
$$;

-- change a role (token only) — keep at least one active admin
create function public.admin_set_role(session_token text, target_id uuid, new_role text)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  perform public._session_admin(session_token);
  if new_role not in ('admin', 'operator') then
    raise exception 'role must be admin or operator' using errcode = '22023';
  end if;
  update public.employees set role = new_role where id = target_id;
  if not found then
    raise exception 'employee not found' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.employees where role = 'admin' and is_active = true) then
    raise exception 'cannot remove the last active admin' using errcode = '23514';
  end if;
end;
$$;

-- activate / deactivate (token only) — keep at least one active admin
create function public.admin_set_active(session_token text, target_id uuid, new_active boolean)
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
  if not exists (select 1 from public.employees where role = 'admin' and is_active = true) then
    raise exception 'cannot deactivate the last active admin' using errcode = '23514';
  end if;
end;
$$;

-- STEP-UP: add employee — token + fresh password
create function public.admin_add_employee(
  session_token text,
  actor_pin     text,
  new_name      text,
  new_pin       text,
  new_role      text
)
returns void
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare v_admin uuid;
begin
  v_admin := public._session_admin(session_token);
  perform public._assert_step_up(v_admin, actor_pin);
  if coalesce(btrim(new_name), '') = '' then
    raise exception 'name is required' using errcode = '22023';
  end if;
  if not public._valid_password(new_pin) then
    raise exception 'password does not meet policy' using errcode = '22023';
  end if;
  if new_role not in ('admin', 'operator') then
    raise exception 'role must be admin or operator' using errcode = '22023';
  end if;
  insert into public.employees (name, pin_hash, role, is_active)
  values (btrim(new_name), crypt(new_pin, gen_salt('bf')), new_role, true);
end;
$$;

-- STEP-UP: unlock a locked account — token + fresh password
create function public.admin_unlock_employee(session_token text, actor_pin text, target_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare v_admin uuid;
begin
  v_admin := public._session_admin(session_token);
  perform public._assert_step_up(v_admin, actor_pin);
  update public.employees set failed_attempts = 0, locked_until = null where id = target_id;
  if not found then
    raise exception 'employee not found' using errcode = 'P0002';
  end if;
end;
$$;

-- ----------------------------------------------------------------------------
-- verify_pin — now returns retry_after_seconds (computed in DB) and auto-resets
-- an expired lock so the user gets a fresh set of attempts.
-- ----------------------------------------------------------------------------
create function public.verify_pin(emp_id uuid, pin_input text)
returns table (id uuid, name text, role text, locked_until timestamptz, retry_after_seconds integer)
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare
  emp        public.employees%rowtype;
  v_failed   integer;
  v_lock     timestamptz;
begin
  select * into emp from public.employees e where e.id = emp_id;

  if not found then
    insert into public.login_attempts (employee_id, success, reason) values (null, false, 'unknown_employee');
    return;
  end if;

  if emp.is_active = false then
    insert into public.login_attempts (employee_id, success, reason) values (emp.id, false, 'inactive');
    return;
  end if;

  -- expired lock -> clear it and give a fresh set of attempts
  if emp.locked_until is not null and emp.locked_until <= now() then
    update public.employees e set failed_attempts = 0, locked_until = null where e.id = emp.id;
    emp.failed_attempts := 0;
    emp.locked_until := null;
  end if;

  -- currently locked -> reject immediately
  if emp.locked_until is not null and emp.locked_until > now() then
    insert into public.login_attempts (employee_id, success, reason) values (emp.id, false, 'locked');
    return query select null::uuid, null::text, null::text, emp.locked_until,
                        greatest(0, ceil(extract(epoch from (emp.locked_until - now())))::int);
    return;
  end if;

  if emp.pin_hash is not null and crypt(pin_input, emp.pin_hash) = emp.pin_hash then
    update public.employees e set failed_attempts = 0, locked_until = null where e.id = emp.id;
    insert into public.login_attempts (employee_id, success, reason) values (emp.id, true, null);
    return query select emp.id, emp.name, emp.role, null::timestamptz, 0;
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
                          greatest(0, ceil(extract(epoch from (v_lock - now())))::int);
    end if;
    return;
  end if;
end;
$$;

-- ----------------------------------------------------------------------------
-- Privileges
-- ----------------------------------------------------------------------------
revoke all on function public._session_admin(text)              from public;
revoke all on function public._assert_step_up(uuid, text)       from public;

grant execute on function public.admin_login(text)                                  to anon, authenticated;
grant execute on function public.admin_logout(text)                                 to anon, authenticated;
grant execute on function public.admin_list_employees(text)                         to anon, authenticated;
grant execute on function public.admin_list_login_attempts(text, integer)           to anon, authenticated;
grant execute on function public.admin_set_pin(text, uuid, text)                    to anon, authenticated;
grant execute on function public.admin_set_role(text, uuid, text)                   to anon, authenticated;
grant execute on function public.admin_set_active(text, uuid, boolean)              to anon, authenticated;
grant execute on function public.admin_add_employee(text, text, text, text, text)   to anon, authenticated;
grant execute on function public.admin_unlock_employee(text, text, uuid)            to anon, authenticated;
grant execute on function public.verify_pin(uuid, text)                             to anon, authenticated;

-- ----------------------------------------------------------------------------
-- Verify:
--   select * from public.admin_login('Admin!23');                 -- returns a token
--   select * from public.admin_list_employees('<token-from-above>');
--   select * from public.verify_pin('00000000-0000-0000-0000-000000000001','nope'); -- retry_after_seconds after 3 fails
-- ----------------------------------------------------------------------------
