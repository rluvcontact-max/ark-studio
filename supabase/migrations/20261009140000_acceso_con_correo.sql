-- Los empleados inician sesión con su correo (antes, usuario corto + @arkstudio.app).
-- Crea o actualiza la cuenta de un empleado (solo admin). Desde ahora el acceso es con correo.
create or replace function public.admin_guardar_acceso(p_empleado text, p_usuario text, p_password text default null)
returns void language plpgsql security definer set search_path = public, auth, extensions as $$
declare
  v_usuario text := lower(trim(p_usuario));
  v_email text;
  v_uid uuid;
begin
  if not public.es_admin() then raise exception 'Solo el administrador puede hacer esto' using errcode = '42501'; end if;
  if v_usuario !~ '^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$' then raise exception 'Escribe un correo válido, por ejemplo nombre@gmail.com'; end if;
  if p_password is not null and length(p_password) > 0 and length(p_password) < 6 then raise exception 'La contraseña debe tener al menos 6 caracteres'; end if;
  if not exists (select 1 from public.empleados where id = p_empleado) then raise exception 'El empleado no existe'; end if;
  if exists (select 1 from public.perfiles where usuario = v_usuario and coalesce(empleado_id,'') <> p_empleado) then
    raise exception 'Ese correo ya lo usa otra persona';
  end if;
  v_email := public._email_de(v_usuario);
  update public.empleados set data = data || jsonb_build_object('email', v_email) where id = p_empleado;
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

