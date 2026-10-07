-- Usuarios sin '@' se convierten en <usuario>@arkstudio.app para Supabase Auth
create or replace function public._email_de(p_usuario text) returns text
language sql immutable set search_path = public as $$
  select case when position('@' in p_usuario) > 0 then lower(p_usuario) else lower(p_usuario) || '@arkstudio.app' end;
$$;

-- Crea o actualiza la cuenta de un empleado (solo admin)
create or replace function public.admin_guardar_acceso(p_empleado text, p_usuario text, p_password text default null)
returns void language plpgsql security definer set search_path = public, auth, extensions as $$
declare
  v_usuario text := lower(trim(p_usuario));
  v_email text;
  v_uid uuid;
begin
  if not public.es_admin() then raise exception 'Solo el administrador puede hacer esto' using errcode = '42501'; end if;
  if v_usuario !~ '^[a-z0-9._-]{3,30}$' then raise exception 'Usuario inválido: usa 3 a 30 letras, números, punto, guion o guion bajo'; end if;
  if p_password is not null and length(p_password) > 0 and length(p_password) < 6 then raise exception 'La contraseña debe tener al menos 6 caracteres'; end if;
  if not exists (select 1 from public.empleados where id = p_empleado) then raise exception 'El empleado no existe'; end if;
  if exists (select 1 from public.perfiles where usuario = v_usuario and coalesce(empleado_id,'') <> p_empleado) then
    raise exception 'Ese usuario ya lo tiene otra persona';
  end if;
  v_email := public._email_de(v_usuario);
  select user_id into v_uid from public.perfiles where empleado_id = p_empleado and rol = 'empleado';
  if v_uid is null then
    if p_password is null or length(p_password) = 0 then raise exception 'Escribe una contraseña'; end if;
    v_uid := gen_random_uuid();
    insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
      confirmation_token, email_change, email_change_token_new, recovery_token)
    values ('00000000-0000-0000-0000-000000000000', v_uid, 'authenticated', 'authenticated', v_email,
      crypt(p_password, gen_salt('bf')), now(),
      '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now(), '', '', '', '');
    insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
    values (gen_random_uuid(), v_uid, v_uid::text,
      jsonb_build_object('sub', v_uid::text, 'email', v_email, 'email_verified', true), 'email', now(), now(), now());
    insert into public.perfiles (user_id, rol, empleado_id, usuario) values (v_uid, 'empleado', p_empleado, v_usuario);
  else
    update auth.users set email = v_email, updated_at = now(),
      encrypted_password = case when p_password is not null and length(p_password) > 0 then crypt(p_password, gen_salt('bf')) else encrypted_password end
      where id = v_uid;
    update auth.identities set identity_data = identity_data || jsonb_build_object('email', v_email), updated_at = now()
      where user_id = v_uid and provider = 'email';
    update public.perfiles set usuario = v_usuario where user_id = v_uid;
    if p_password is not null and length(p_password) > 0 then
      delete from auth.sessions where user_id = v_uid;  -- cierra sus sesiones abiertas
    end if;
  end if;
end $$;

-- Quita el acceso de un empleado (solo admin)
create or replace function public.admin_quitar_acceso(p_empleado text)
returns void language plpgsql security definer set search_path = public, auth as $$
declare v_uid uuid;
begin
  if not public.es_admin() then raise exception 'Solo el administrador puede hacer esto' using errcode = '42501'; end if;
  select user_id into v_uid from public.perfiles where empleado_id = p_empleado and rol = 'empleado';
  if v_uid is not null then delete from auth.users where id = v_uid; end if;
end $$;

revoke all on function public.admin_guardar_acceso(text,text,text) from public, anon;
revoke all on function public.admin_quitar_acceso(text) from public, anon;
revoke all on function public._email_de(text) from public, anon;
grant execute on function public.admin_guardar_acceso(text,text,text) to authenticated;
grant execute on function public.admin_quitar_acceso(text) to authenticated;
