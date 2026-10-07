-- NOTA: estas funciones eran para reservar en el calendario propio de ARK (referencia/reservar-calendario-propio.html).
-- Se decidió usar Google Calendar; hoy no las usa ninguna página, pero siguen en la base de datos.

insert into public.config (id, data) values ('reservas',
  '{"dias":[1,2,3,4,5],"inicio":"10:00","fin":"18:00","intervalo":30,"duracion":10,"anticipacion_horas":2,"dias_adelante":14}'::jsonb)
on conflict (id) do nothing;

-- Nombre y foto del asesor del link (público)
create or replace function public.reserva_anfitrion(p_asesor text)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', id, 'nombre', data->>'nombre', 'foto', data->>'foto')
  from public.empleados where id = p_asesor;
$$;

-- Horarios libres del asesor (público)
create or replace function public.reserva_horarios(p_asesor text)
returns table(fecha date, hora text) language sql stable security definer set search_path = public as $$
  with cfg as (
    select coalesce((select data from public.config where id = 'reservas'),
      '{"dias":[1,2,3,4,5],"inicio":"10:00","fin":"18:00","intervalo":30,"duracion":10,"anticipacion_horas":2,"dias_adelante":14}'::jsonb) c
  ), a as (
    select coalesce((select id from public.empleados where id = p_asesor), '') asesor
  ), ahora as (select (now() at time zone 'America/Mexico_City') t)
  select d::date, to_char(s, 'HH24:MI')
  from cfg, a, ahora,
    generate_series(ahora.t::date, ahora.t::date + (cfg.c->>'dias_adelante')::int, interval '1 day') d,
    generate_series(timestamp '2000-01-01' + (cfg.c->>'inicio')::time,
                    timestamp '2000-01-01' + (cfg.c->>'fin')::time - make_interval(mins => (cfg.c->>'duracion')::int),
                    make_interval(mins => (cfg.c->>'intervalo')::int)) s
  where extract(isodow from d)::int in (select jsonb_array_elements_text(cfg.c->'dias')::int)
    and (d::date + s::time) > ahora.t + make_interval(hours => (cfg.c->>'anticipacion_horas')::int)
    and not exists (
      select 1 from public.eventos e
      where coalesce(e.empleado_id, '') = a.asesor
        and e.data->>'fecha' = to_char(d, 'YYYY-MM-DD')
        and coalesce(e.data->>'hora', '') ~ '^\d{2}:\d{2}$'
        and (e.data->>'hora')::time < s::time + make_interval(mins => (cfg.c->>'duracion')::int)
        and (e.data->>'hora')::time + make_interval(mins => coalesce(nullif(nullif(e.data->>'duracion', ''), '0')::int, 30)) > s::time
    )
  order by 1, 2;
$$;

-- Reservar (público): registra al prospecto y crea la cita en el calendario del asesor
create or replace function public.reservar(p_asesor text, p_fecha date, p_hora text, p_datos jsonb)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_asesor text := coalesce((select id from public.empleados where id = p_asesor), '');
  v_nombre text := left(trim(coalesce(p_datos->>'nombre', '')), 120);
  v_negocio text := left(trim(coalesce(p_datos->>'negocio', '')), 120);
  v_wa text := left(regexp_replace(coalesce(p_datos->>'whatsapp', ''), '[^0-9+ ]', '', 'g'), 25);
  v_correo text := left(trim(coalesce(p_datos->>'correo', '')), 160);
  v_dur int := coalesce((select (data->>'duracion')::int from public.config where id = 'reservas'), 10);
  v_ms bigint := (extract(epoch from now()) * 1000)::bigint;
  v_notas text;
  v_cliente text;
  v_evento text;
begin
  if v_nombre = '' or v_negocio = '' or length(regexp_replace(v_wa, '\D', '', 'g')) < 10 then
    raise exception 'Faltan tu nombre, tu negocio o tu WhatsApp';
  end if;
  perform pg_advisory_xact_lock(hashtext(v_asesor || p_fecha::text || p_hora));
  if not exists (select 1 from public.reserva_horarios(v_asesor) h where h.fecha = p_fecha and h.hora = p_hora) then
    raise exception 'Ese horario ya no está disponible. Elige otro.';
  end if;
  if (select count(*) from public.eventos where data->>'origen' = 'encuesta' and data->>'whatsapp' = v_wa
      and creado > now() - interval '1 day') >= 2 then
    raise exception 'Ya tienes una llamada agendada. Si necesitas cambiarla, escríbenos por WhatsApp.';
  end if;
  v_notas := concat_ws(E'\n',
    'Llegó por la encuesta.',
    nullif('Giro: ' || left(coalesce(p_datos->>'giro', ''), 200), 'Giro: '),
    nullif('Sistemas: ' || left(coalesce(p_datos->>'sistemas', ''), 1500), 'Sistemas: '),
    nullif('Para: ' || left(coalesce(p_datos->>'usuarios', ''), 200), 'Para: '),
    nullif('Plataforma: ' || left(coalesce(p_datos->>'plataforma', ''), 200), 'Plataforma: '),
    nullif('Para cuándo: ' || left(coalesce(p_datos->>'tiempo', ''), 200), 'Para cuándo: '),
    nullif('Comentarios: ' || left(coalesce(p_datos->>'comentarios', ''), 1000), 'Comentarios: '));
  insert into public.clientes (data) values (jsonb_build_object(
    'empresa', v_negocio, 'contacto', v_nombre, 'telefono', v_wa, 'email', v_correo,
    'empleadoId', v_asesor, 'estado', 'prospecto', 'tipoApp', '', 'valor', 0,
    'notas', v_notas, 'origen', 'encuesta', 'creado', v_ms, 'actualizado', v_ms))
  returning id into v_cliente;
  insert into public.eventos (data) values (jsonb_build_object(
    'titulo', 'Llamada de presentación · ' || v_negocio, 'fecha', to_char(p_fecha, 'YYYY-MM-DD'), 'hora', p_hora,
    'duracion', v_dur, 'tipo', 'Presentación', 'modalidad', 'Virtual', 'empleadoId', v_asesor, 'clienteId', v_cliente,
    'notas', 'Reservada desde la encuesta. WhatsApp: ' || v_wa || '. Mandarle el enlace de la videollamada por WhatsApp.',
    'origen', 'encuesta', 'whatsapp', v_wa, 'creado', v_ms))
  returning id into v_evento;
  return jsonb_build_object('ok', true, 'fecha', p_fecha, 'hora', p_hora, 'duracion', v_dur,
    'anfitrion', coalesce((select data->>'nombre' from public.empleados where id = v_asesor), 'Ricardo'));
end $$;

revoke all on function public.reserva_anfitrion(text) from public;
revoke all on function public.reserva_horarios(text) from public;
revoke all on function public.reservar(text, date, text, jsonb) from public;
grant execute on function public.reserva_anfitrion(text) to anon, authenticated;
grant execute on function public.reserva_horarios(text) to anon, authenticated;
grant execute on function public.reservar(text, date, text, jsonb) to anon, authenticated;
