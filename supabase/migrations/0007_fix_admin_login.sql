-- =============================================================================
-- OPS Dashboard — fix: admin_login() "column reference expires_at is ambiguous"
--
-- admin_login RETURNS TABLE (token, expires_at), which creates OUT variables
-- named token/expires_at. The opportunistic cleanup line referenced the table
-- column `expires_at` UNQUALIFIED, so PL/pgSQL couldn't tell the OUT variable
-- from the column (SQLSTATE 42702) and the whole function aborted — every
-- admin_login call failed regardless of the password.
--
-- Fix: qualify the column with the table alias. Return type is unchanged, so
-- CREATE OR REPLACE keeps the existing EXECUTE grants.
--
-- Safe to re-run. idempotent.
-- =============================================================================

set search_path = public, extensions;

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
  -- tidy up expired sessions opportunistically (qualified column -> unambiguous)
  delete from public.admin_sessions s where s.expires_at <= now();

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
-- Verify (use YOUR current admin password):
--   select * from public.admin_login('<your-password>');   -- should return a token
-- ----------------------------------------------------------------------------
