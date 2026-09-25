-- =============================================================================
-- OPS Dashboard — real passwords, hashing, lockout, and login audit
--
-- Upgrades auth from a 4-digit plaintext PIN to a hashed password with a
-- server-enforced policy, brute-force lockout, and a login-attempt log.
--
--  1) Password policy (server-enforced): >= 6 chars, >= 1 letter, >= 1 digit,
--     >= 1 symbol.
--  2) Storage: pgcrypto bcrypt hash in employees.pin_hash; the plaintext `pin`
--     column is dropped. Verification uses crypt(input, pin_hash) = pin_hash.
--  3) Lockout: 3 consecutive failures -> locked_until = now()+30min. While
--     locked, verify_pin rejects immediately without checking the password.
--  4) Audit: every attempt is written to login_attempts; admins can read it.
--
-- NOTE: crypt()/gen_salt() live in the pgcrypto extension, which on Supabase is
-- usually in the `extensions` schema — so search_path includes it. A schema
-- that doesn't exist in search_path is simply ignored, so this is safe anywhere.
--
-- Safe to re-run. idempotent.
-- =============================================================================

set search_path = public, extensions;

create extension if not exists pgcrypto;

-- ----------------------------------------------------------------------------
-- Schema changes
-- ----------------------------------------------------------------------------
alter table public.employees add column if not exists pin_hash        text;
alter table public.employees add column if not exists failed_attempts integer not null default 0;
alter table public.employees add column if not exists locked_until    timestamptz;

-- One-time migration from plaintext pin -> hash (only while the column exists).
-- On first run this also resets the 5 seed accounts to policy-compliant
-- temporary passwords; on later runs the block is skipped so it never clobbers
-- passwords set through the UI.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'employees' and column_name = 'pin'
  ) then
    -- keep any non-seed employees working: hash whatever plaintext they had
    update public.employees
       set pin_hash = crypt(pin, gen_salt('bf'))
     where pin_hash is null and pin is not null;

    -- seed accounts -> temporary compliant passwords (see chat for the list)
    update public.employees set pin_hash = crypt('Admin!23',  gen_salt('bf')) where id = '00000000-0000-0000-0000-000000000001';
    update public.employees set pin_hash = crypt('Worker1!',  gen_salt('bf')) where id = '00000000-0000-0000-0000-000000000002';
    update public.employees set pin_hash = crypt('Worker2@',  gen_salt('bf')) where id = '00000000-0000-0000-0000-000000000003';
    update public.employees set pin_hash = crypt('Worker3#',  gen_salt('bf')) where id = '00000000-0000-0000-0000-000000000004';
    update public.employees set pin_hash = crypt('Worker4$',  gen_salt('bf')) where id = '00000000-0000-0000-0000-000000000005';
  end if;
end $$;

alter table public.employees drop column if exists pin;
alter table public.employees alter column pin_hash set not null;

-- ----------------------------------------------------------------------------
-- Login attempt audit log
-- ----------------------------------------------------------------------------
create table if not exists public.login_attempts (
  id           uuid primary key default gen_random_uuid(),
  employee_id  uuid references public.employees(id),  -- null when the name wasn't matched
  attempted_at timestamptz not null default now(),
  success      boolean not null,
  reason       text                                    -- 'wrong_password' | 'locked' | 'unknown_employee' | 'inactive'
);
create index if not exists idx_login_attempts_time on public.login_attempts (attempted_at desc);

alter table public.login_attempts enable row level security;
-- no client policies: reachable only via the SECURITY DEFINER RPCs below.

-- ----------------------------------------------------------------------------
-- Password policy (server-side, authoritative)
--   >= 6 chars, at least one letter (A-Za-z), one digit, one symbol.
-- ----------------------------------------------------------------------------
create or replace function public._valid_password(pw text)
returns boolean
language sql
immutable
as $$
  select pw is not null
     and length(pw) >= 6
     and pw ~ '[A-Za-z]'
     and pw ~ '[0-9]'
     and pw ~ '[!@#$%^&*()_+=.,;:?/|~<>{}]';
$$;

-- ----------------------------------------------------------------------------
-- Admin guard — now compares against the hash.
-- ----------------------------------------------------------------------------
create or replace function public._assert_admin(actor_pin text)
returns void
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
begin
  if actor_pin is null or not exists (
    select 1 from public.employees
    where role = 'admin'
      and is_active = true
      and pin_hash is not null
      and crypt(actor_pin, pin_hash) = pin_hash
  ) then
    raise exception 'unauthorized: actor is not an active admin' using errcode = '42501';
  end if;
end;
$$;

-- ----------------------------------------------------------------------------
-- verify_pin — hashed check + lockout + audit.
-- Return contract:
--   success        -> one row with id/name/role set, locked_until null
--   locked         -> one row with id null and locked_until = when it unlocks
--   wrong/unknown  -> no rows
-- Return type changed, so drop + recreate (and re-grant).
-- ----------------------------------------------------------------------------
drop function if exists public.verify_pin(uuid, text);
create function public.verify_pin(emp_id uuid, pin_input text)
returns table (id uuid, name text, role text, locked_until timestamptz)
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare emp public.employees%rowtype;
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

  -- already locked -> reject immediately, do not check the password
  if emp.locked_until is not null and emp.locked_until > now() then
    insert into public.login_attempts (employee_id, success, reason) values (emp.id, false, 'locked');
    return query select null::uuid, null::text, null::text, emp.locked_until;
    return;
  end if;

  if emp.pin_hash is not null and crypt(pin_input, emp.pin_hash) = emp.pin_hash then
    update public.employees e set failed_attempts = 0, locked_until = null where e.id = emp.id;
    insert into public.login_attempts (employee_id, success, reason) values (emp.id, true, null);
    return query select emp.id, emp.name, emp.role, null::timestamptz;
    return;
  else
    update public.employees e
       set failed_attempts = emp.failed_attempts + 1,
           locked_until = case when emp.failed_attempts + 1 >= 3 then now() + interval '30 minutes' else e.locked_until end
     where e.id = emp.id;
    insert into public.login_attempts (employee_id, success, reason) values (emp.id, false, 'wrong_password');
    return;
  end if;
end;
$$;

-- ----------------------------------------------------------------------------
-- admin_add_employee / admin_set_pin — take a raw password, validate, hash.
-- ----------------------------------------------------------------------------
create or replace function public.admin_add_employee(
  actor_pin text,
  new_name  text,
  new_pin   text,
  new_role  text
)
returns void
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
begin
  perform public._assert_admin(actor_pin);
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

create or replace function public.admin_set_pin(
  actor_pin text,
  target_id uuid,
  new_pin   text
)
returns void
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
begin
  perform public._assert_admin(actor_pin);
  if not public._valid_password(new_pin) then
    raise exception 'password does not meet policy' using errcode = '22023';
  end if;
  update public.employees set pin_hash = crypt(new_pin, gen_salt('bf')) where id = target_id;
  if not found then
    raise exception 'employee not found' using errcode = 'P0002';
  end if;
end;
$$;

-- ----------------------------------------------------------------------------
-- admin_list_login_attempts — recent attempts with employee name.
-- ----------------------------------------------------------------------------
create or replace function public.admin_list_login_attempts(actor_pin text, limit_count integer default 50)
returns table (
  id           uuid,
  employee_id  uuid,
  employee_name text,
  attempted_at timestamptz,
  success      boolean,
  reason       text
)
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
begin
  perform public._assert_admin(actor_pin);
  return query
    select la.id, la.employee_id, e.name, la.attempted_at, la.success, la.reason
    from public.login_attempts la
    left join public.employees e on e.id = la.employee_id
    order by la.attempted_at desc
    limit greatest(1, least(coalesce(limit_count, 50), 500));
end;
$$;

-- ----------------------------------------------------------------------------
-- Privileges
-- ----------------------------------------------------------------------------
revoke all on function public._valid_password(text)                       from public;
revoke all on function public._assert_admin(text)                         from public;
revoke all on function public.verify_pin(uuid, text)                      from public;
revoke all on function public.admin_add_employee(text, text, text, text)  from public;
revoke all on function public.admin_set_pin(text, uuid, text)             from public;
revoke all on function public.admin_list_login_attempts(text, integer)    from public;

grant execute on function public.verify_pin(uuid, text)                     to anon, authenticated;
grant execute on function public.admin_add_employee(text, text, text, text) to anon, authenticated;
grant execute on function public.admin_set_pin(text, uuid, text)            to anon, authenticated;
grant execute on function public.admin_list_login_attempts(text, integer)   to anon, authenticated;

-- ----------------------------------------------------------------------------
-- Verify:
--   select * from public.verify_pin('00000000-0000-0000-0000-000000000001', 'Admin!23'); -- 1 row
--   select * from public.verify_pin('00000000-0000-0000-0000-000000000001', 'nope');      -- 0 rows
--   select * from public.admin_list_login_attempts('Admin!23', 20);                       -- recent attempts
-- ----------------------------------------------------------------------------
