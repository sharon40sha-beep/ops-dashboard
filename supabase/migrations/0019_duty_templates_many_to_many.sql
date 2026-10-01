-- =============================================================================
-- OPS Dashboard — 0019: duty-type ↔ checklist-template becomes many-to-many,
-- symmetric with assets↔templates (0017). Checklist templates are ONE shared
-- pool; the admin assigns any template to duty types and/or assets, and picks
-- the relevant one per shift at creation.
--   Before: duty_types.checklist_template_id (one fixed template per type).
--   Now:    duty_type_checklist_templates link table; a shift stores the chosen
--           template in duty_shifts.checklist_template_id and snapshots it.
--
-- Depends on 0012–0018. Migrates the single link before dropping it.
-- Safe to re-run (idempotent).
-- =============================================================================

set search_path = public, extensions;

-- ============================================================================
-- Link table (closed — reached only via SECURITY DEFINER RPCs) + per-shift column
-- ============================================================================
create table if not exists public.duty_type_checklist_templates (
  duty_type_id          uuid not null references public.duty_types(id) on delete cascade,
  checklist_template_id uuid not null references public.checklist_templates(id),
  primary key (duty_type_id, checklist_template_id)
);
create index if not exists idx_dtct_template on public.duty_type_checklist_templates (checklist_template_id);
alter table public.duty_type_checklist_templates enable row level security;

alter table public.duty_shifts add column if not exists checklist_template_id uuid references public.checklist_templates(id);

-- migrate the single link, then drop the column
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='duty_types' and column_name='checklist_template_id') then
    insert into public.duty_type_checklist_templates (duty_type_id, checklist_template_id)
      select id, checklist_template_id from public.duty_types where checklist_template_id is not null
      on conflict do nothing;
  end if;
end $$;

alter table public.duty_types drop column if exists checklist_template_id;

-- ============================================================================
-- Duty-type admin RPCs (signatures change -> drop first).
-- ============================================================================
drop function if exists public.admin_list_duty_types(text);
drop function if exists public.admin_add_duty_type(text, text, uuid);
drop function if exists public.admin_update_duty_type(text, uuid, text, uuid, boolean);

create function public.admin_list_duty_types(session_token text)
returns table (id uuid, label text, is_active boolean, template_ids uuid[])
language plpgsql stable security definer set search_path = public
as $$
begin
  perform public._session_admin(session_token);
  return query
    select dt.id, dt.label, dt.is_active,
           coalesce((select array_agg(x.checklist_template_id order by x.checklist_template_id)
                     from public.duty_type_checklist_templates x where x.duty_type_id = dt.id), '{}')
    from public.duty_types dt order by dt.is_active desc, dt.label;
end;
$$;

create function public.admin_add_duty_type(session_token text, label text, template_ids uuid[])
returns void language plpgsql volatile security definer set search_path = public
as $$
declare v_id uuid; v_t uuid;
begin
  perform public._session_admin(session_token);
  if coalesce(btrim(label), '') = '' then raise exception 'label required' using errcode = '22023'; end if;
  insert into public.duty_types (label, is_active) values (btrim(admin_add_duty_type.label), true) returning id into v_id;
  if template_ids is not null then
    foreach v_t in array template_ids loop
      insert into public.duty_type_checklist_templates (duty_type_id, checklist_template_id)
      values (v_id, v_t) on conflict do nothing;
    end loop;
  end if;
end;
$$;

create function public.admin_update_duty_type(session_token text, id uuid, label text, is_active boolean)
returns void language plpgsql volatile security definer set search_path = public
as $$
begin
  perform public._session_admin(session_token);
  update public.duty_types dt
     set label = coalesce(nullif(btrim(admin_update_duty_type.label), ''), dt.label),
         is_active = coalesce(admin_update_duty_type.is_active, dt.is_active)
   where dt.id = admin_update_duty_type.id;
  if not found then raise exception 'duty type not found' using errcode = 'P0002'; end if;
end;
$$;

create or replace function public.admin_set_duty_type_templates(session_token text, duty_type_id uuid, template_ids uuid[])
returns void language plpgsql volatile security definer set search_path = public
as $$
declare v_t uuid;
begin
  perform public._session_admin(session_token);
  if not exists (select 1 from public.duty_types dt where dt.id = admin_set_duty_type_templates.duty_type_id) then
    raise exception 'duty type not found' using errcode = 'P0002';
  end if;
  delete from public.duty_type_checklist_templates x where x.duty_type_id = admin_set_duty_type_templates.duty_type_id;
  if template_ids is not null then
    foreach v_t in array template_ids loop
      insert into public.duty_type_checklist_templates (duty_type_id, checklist_template_id)
      values (admin_set_duty_type_templates.duty_type_id, v_t) on conflict do nothing;
    end loop;
  end if;
end;
$$;

-- ============================================================================
-- Shift lifecycle: the chosen checklist template travels with the shift.
-- (Signatures change -> drop the 0018 versions first.)
-- ============================================================================
drop function if exists public.create_duty_shift(text, text, uuid[], uuid, timestamptz, timestamptz, text);
drop function if exists public.update_duty_shift(text, uuid, text, uuid[], uuid, timestamptz, timestamptz, text);

create function public.create_duty_shift(
  session_token text, site_id text, worker_ids uuid[], duty_type_id uuid,
  start_time timestamptz, end_time timestamptz, p_label text, p_template_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = public
as $$
declare v_shift public.duty_shifts; v_checklist jsonb; v_w uuid;
begin
  perform public._session_admin(session_token);
  if worker_ids is null or array_length(worker_ids, 1) is null then
    raise exception 'at least one worker required' using errcode = '22023';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('label', ci.label, 'critical', ci.critical, 'checked', false)
                            order by ci.sort_order, ci.label), '[]'::jsonb)
    into v_checklist
    from public.checklist_items ci where ci.template_id = p_template_id and ci.is_active = true;

  insert into public.duty_shifts (site_id, duty_type_id, start_time, end_time, label, checklist_template_id, status, checklist, audit_log)
  values (create_duty_shift.site_id, create_duty_shift.duty_type_id,
          create_duty_shift.start_time, create_duty_shift.end_time, nullif(btrim(p_label), ''),
          p_template_id, 'planned', coalesce(v_checklist, '[]'::jsonb),
          jsonb_build_array(to_char(now(), 'HH24:MI') || ' – Shift created'))
  returning * into v_shift;

  foreach v_w in array worker_ids loop
    insert into public.duty_shift_workers (duty_shift_id, employee_id) values (v_shift.id, v_w) on conflict do nothing;
  end loop;

  return (select public._duty_json(d) from public.duty_shifts d where d.id = v_shift.id);
end;
$$;

create function public.update_duty_shift(
  session_token text, duty_shift_id uuid, site_id text, worker_ids uuid[], duty_type_id uuid,
  start_time timestamptz, end_time timestamptz, p_label text, p_template_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = public
as $$
declare
  v_shift public.duty_shifts; v_changes text[] := '{}';
  v_old_w uuid[]; v_new_w uuid[]; v_checklist jsonb; v_w uuid; v_label text; v_tpl_changed boolean;
begin
  perform public._session_admin(session_token);
  select * into v_shift from public.duty_shifts where id = duty_shift_id;
  if not found then raise exception 'shift not found' using errcode = 'P0002'; end if;
  if v_shift.status <> 'planned' then
    raise exception 'shift is not editable (already started)' using errcode = '22023';
  end if;
  if worker_ids is null or array_length(worker_ids, 1) is null then
    raise exception 'at least one worker required' using errcode = '22023';
  end if;

  v_label := nullif(btrim(p_label), '');
  v_tpl_changed := v_shift.checklist_template_id is distinct from p_template_id;
  select array_agg(dw.employee_id order by dw.employee_id) into v_old_w from public.duty_shift_workers dw where dw.duty_shift_id = update_duty_shift.duty_shift_id;
  select array_agg(w order by w) into v_new_w from unnest(worker_ids) w;

  if v_shift.site_id      is distinct from update_duty_shift.site_id      then v_changes := array_append(v_changes, 'אתר'); end if;
  if v_shift.duty_type_id is distinct from update_duty_shift.duty_type_id then v_changes := array_append(v_changes, 'סוג משמרת'); end if;
  if v_shift.start_time   is distinct from update_duty_shift.start_time   then v_changes := array_append(v_changes, 'התחלה'); end if;
  if v_shift.end_time     is distinct from update_duty_shift.end_time     then v_changes := array_append(v_changes, 'סיום'); end if;
  if v_shift.label        is distinct from v_label                        then v_changes := array_append(v_changes, 'תווית'); end if;
  if v_tpl_changed                                                        then v_changes := array_append(v_changes, 'צ׳קליסט'); end if;
  if coalesce(v_old_w, '{}') is distinct from coalesce(v_new_w, '{}') then v_changes := array_append(v_changes, 'עובדים'); end if;

  -- rebuild the checklist snapshot only when the chosen template changed
  if v_tpl_changed then
    select coalesce(jsonb_agg(jsonb_build_object('label', ci.label, 'critical', ci.critical, 'checked', false)
                              order by ci.sort_order, ci.label), '[]'::jsonb)
      into v_checklist from public.checklist_items ci where ci.template_id = p_template_id and ci.is_active = true;
  end if;

  update public.duty_shifts d set
    site_id      = update_duty_shift.site_id,
    duty_type_id = update_duty_shift.duty_type_id,
    start_time   = update_duty_shift.start_time,
    end_time     = update_duty_shift.end_time,
    label        = v_label,
    checklist_template_id = p_template_id,
    checklist      = case when v_tpl_changed then coalesce(v_checklist, '[]'::jsonb) else d.checklist end,
    checklist_note = case when v_tpl_changed then null else d.checklist_note end,
    audit_log = d.audit_log || jsonb_build_array(to_char(now(), 'HH24:MI') || ' – Edited by admin: ' ||
      coalesce(nullif(array_to_string(v_changes, ', '), ''), 'ללא שינוי'))
  where d.id = update_duty_shift.duty_shift_id;

  delete from public.duty_shift_workers dw where dw.duty_shift_id = update_duty_shift.duty_shift_id;
  foreach v_w in array worker_ids loop
    insert into public.duty_shift_workers (duty_shift_id, employee_id) values (update_duty_shift.duty_shift_id, v_w) on conflict do nothing;
  end loop;

  return (select public._duty_json(d) from public.duty_shifts d where d.id = update_duty_shift.duty_shift_id);
end;
$$;

-- ============================================================================
-- Privileges
-- ============================================================================
grant execute on function public.admin_list_duty_types(text)                                to anon, authenticated;
grant execute on function public.admin_add_duty_type(text, text, uuid[])                     to anon, authenticated;
grant execute on function public.admin_update_duty_type(text, uuid, text, boolean)           to anon, authenticated;
grant execute on function public.admin_set_duty_type_templates(text, uuid, uuid[])           to anon, authenticated;
grant execute on function public.create_duty_shift(text, text, uuid[], uuid, timestamptz, timestamptz, text, uuid) to anon, authenticated;
grant execute on function public.update_duty_shift(text, uuid, text, uuid[], uuid, timestamptz, timestamptz, text, uuid) to anon, authenticated;

-- ----------------------------------------------------------------------------
-- Verify (admin token):
--   select * from public.admin_list_duty_types('<admin>');
--   select public.admin_set_duty_type_templates('<admin>','<type-uuid>', array['<tpl>']::uuid[]);
--   select public.create_duty_shift('<admin>','S01', array['<w>']::uuid[], '<type>',
--     now(), now()+interval '8h', 'משמרת לילה', '<tpl-uuid>');
-- ----------------------------------------------------------------------------
