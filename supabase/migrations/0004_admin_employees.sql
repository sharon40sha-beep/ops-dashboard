-- =============================================================================
-- OPS Dashboard — admin employee management
-- Adds employees.is_active + admin-only SECURITY DEFINER RPCs so an admin can
-- add employees, change PINs, change roles, and deactivate/reactivate access
-- from the UI — no manual SQL.
--
-- Security model (unchanged intent): the employees table is NEVER exposed to
-- the client. Every RPC here is SECURITY DEFINER and takes actor_pin, which
-- must belong to an ACTIVE ADMIN or the call is rejected. PINs are never
-- returned to the client, not even to an admin.
--
-- Safe to re-run. idempotent.
-- =============================================================================

-- ----------------------------------------------------------------------------
-- Schema: is_active flag (deactivate = revoke access without deleting history)
-- ----------------------------------------------------------------------------
alter table public.employees
  add column if not exists is_active boolean not null default true;

-- ----------------------------------------------------------------------------
-- Login list now hides inactive employees entirely.
-- ----------------------------------------------------------------------------
create or replace function public.list_login_employees()
returns table (id uuid, name text, role text)
language sql
stable
security definer
set search_path = public
as $$
  select e.id, e.name, e.role
  from public.employees e
  where e.is_active = true
  order by e.role, e.name;
$$;

-- ----------------------------------------------------------------------------
-- Internal guard: raise unless actor_pin belongs to an active admin.
-- Not granted to anon — only the admin_* functions (running as owner) call it.
-- ----------------------------------------------------------------------------
create or replace function public._assert_admin(actor_pin text)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if actor_pin is null or not exists (
    select 1 from public.employees
    where pin = actor_pin and role = 'admin' and is_active = true
  ) then
    raise exception 'unauthorized: actor is not an active admin' using errcode = '42501';
  end if;
end;
$$;

-- ----------------------------------------------------------------------------
-- admin_list_employees — full roster incl. is_active (never the PIN)
-- ----------------------------------------------------------------------------
create or replace function public.admin_list_employees(actor_pin text)
returns table (id uuid, name text, role text, is_active boolean)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public._assert_admin(actor_pin);
  return query
    select e.id, e.name, e.role, e.is_active
    from public.employees e
    order by e.is_active desc, e.role, e.name;
end;
$$;

-- ----------------------------------------------------------------------------
-- admin_add_employee(actor_pin, new_name, new_pin, new_role)
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
set search_path = public
as $$
begin
  perform public._assert_admin(actor_pin);
  if coalesce(btrim(new_name), '') = '' then
    raise exception 'name is required' using errcode = '22023';
  end if;
  if new_pin !~ '^\d{4}$' then
    raise exception 'pin must be exactly 4 digits' using errcode = '22023';
  end if;
  if new_role not in ('admin', 'operator') then
    raise exception 'role must be admin or operator' using errcode = '22023';
  end if;
  insert into public.employees (name, pin, role, is_active)
  values (btrim(new_name), new_pin, new_role, true);
end;
$$;

-- ----------------------------------------------------------------------------
-- admin_set_pin(actor_pin, target_id, new_pin)
-- ----------------------------------------------------------------------------
create or replace function public.admin_set_pin(
  actor_pin text,
  target_id uuid,
  new_pin   text
)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  perform public._assert_admin(actor_pin);
  if new_pin !~ '^\d{4}$' then
    raise exception 'pin must be exactly 4 digits' using errcode = '22023';
  end if;
  update public.employees set pin = new_pin where id = target_id;
  if not found then
    raise exception 'employee not found' using errcode = 'P0002';
  end if;
end;
$$;

-- ----------------------------------------------------------------------------
-- admin_set_role(actor_pin, target_id, new_role)
-- Guard: never leave the system without at least one active admin.
-- ----------------------------------------------------------------------------
create or replace function public.admin_set_role(
  actor_pin text,
  target_id uuid,
  new_role  text
)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  perform public._assert_admin(actor_pin);
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

-- ----------------------------------------------------------------------------
-- admin_set_active(actor_pin, target_id, new_active) — deactivate / reactivate
-- Guard: never deactivate the last active admin.
-- ----------------------------------------------------------------------------
create or replace function public.admin_set_active(
  actor_pin  text,
  target_id  uuid,
  new_active boolean
)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  perform public._assert_admin(actor_pin);
  update public.employees set is_active = new_active where id = target_id;
  if not found then
    raise exception 'employee not found' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.employees where role = 'admin' and is_active = true) then
    raise exception 'cannot deactivate the last active admin' using errcode = '23514';
  end if;
end;
$$;

-- ----------------------------------------------------------------------------
-- Privileges: expose only the admin_* + login RPCs to the client roles.
-- _assert_admin stays internal (revoked from public).
-- ----------------------------------------------------------------------------
revoke all on function public._assert_admin(text)                      from public;
revoke all on function public.admin_list_employees(text)               from public;
revoke all on function public.admin_add_employee(text, text, text, text) from public;
revoke all on function public.admin_set_pin(text, uuid, text)          from public;
revoke all on function public.admin_set_role(text, uuid, text)         from public;
revoke all on function public.admin_set_active(text, uuid, boolean)    from public;

grant execute on function public.list_login_employees()                   to anon, authenticated;
grant execute on function public.admin_list_employees(text)               to anon, authenticated;
grant execute on function public.admin_add_employee(text, text, text, text) to anon, authenticated;
grant execute on function public.admin_set_pin(text, uuid, text)          to anon, authenticated;
grant execute on function public.admin_set_role(text, uuid, text)         to anon, authenticated;
grant execute on function public.admin_set_active(text, uuid, boolean)    to anon, authenticated;

-- ----------------------------------------------------------------------------
-- Verify (as an admin, replace 1234 with a real active-admin PIN):
--   select * from public.admin_list_employees('1234');   -- roster incl. is_active
--   select * from public.admin_list_employees('9999');   -- should raise unauthorized
-- ----------------------------------------------------------------------------
