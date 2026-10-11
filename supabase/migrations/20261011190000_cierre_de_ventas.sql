-- Cierre de ventas con documentos.
-- Etapas después de la propuesta (estado sigue siendo 'cerrado' para no romper ventas, bonos y ranking):
--   1. Contrato firmado: el vendedor (o el admin) sube el comprobante del pago y el contrato firmado
--      → RPC cerrar_trato: registra el ingreso en finanzas (cuenta como venta), estado 'cerrado', data.cierre.
--      Para el empleado se ve "Cerrado"; para el admin, "Creación de app".
--   2. Venta completada: el admin sube el comprobante del pago restante
--      → RPC completar_venta: registra el ingreso, data.completado. Queda en "Negocios con app".
-- Los archivos van en el bucket privado `documentos`, en la carpeta <clienteId>/.

-- ============ Archivos ============
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('documentos', 'documentos', false, 20971520,
        array['image/jpeg','image/png','image/webp','image/heic','image/heif','application/pdf'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- El admin ve y sube todo; el empleado solo en la carpeta de sus clientes. Borrar/reemplazar: solo admin.
create policy documentos_select on storage.objects for select to authenticated
  using (bucket_id = 'documentos' and (public.es_admin() or exists (
    select 1 from public.clientes c where c.id = (storage.foldername(name))[1] and c.empleado_id = public.mi_empleado())));
create policy documentos_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'documentos' and (public.es_admin() or exists (
    select 1 from public.clientes c where c.id = (storage.foldername(name))[1] and c.empleado_id = public.mi_empleado())));
create policy documentos_update on storage.objects for update to authenticated
  using (bucket_id = 'documentos' and public.es_admin()) with check (bucket_id = 'documentos' and public.es_admin());
create policy documentos_delete on storage.objects for delete to authenticated
  using (bucket_id = 'documentos' and public.es_admin());

-- ============ Candado: cerrar solo con documentos ============
-- Nadie pone 'cerrado' ni toca data.cierre / data.completado a mano: solo las RPC (marcan ark.cierre = '1').
-- Si una edición normal llega sin esos campos (datos viejos en pantalla), se conservan los que ya había.
create or replace function public._candado_cierre() returns trigger
language plpgsql set search_path = public as $$
begin
  if coalesce(current_setting('ark.cierre', true), '') = '1' then return new; end if;
  if tg_op = 'INSERT' then
    if new.data->>'estado' = 'cerrado' then
      raise exception 'Para cerrar un trato sube el comprobante de pago y el contrato firmado (botón "Contrato firmado").';
    end if;
    new.data := new.data - 'cierre' - 'completado';
    return new;
  end if;
  new.data := (new.data - 'cierre' - 'completado')
    || jsonb_strip_nulls(jsonb_build_object('cierre', old.data->'cierre', 'completado', old.data->'completado'));
  if new.data->>'estado' = 'cerrado' and coalesce(old.data->>'estado', '') <> 'cerrado' then
    raise exception 'Para cerrar un trato sube el comprobante de pago y el contrato firmado (botón "Contrato firmado").';
  end if;
  -- reabrir un trato cerrado (sacarlo de 'cerrado'): solo el admin
  if old.data->>'estado' = 'cerrado' and coalesce(new.data->>'estado', '') <> 'cerrado' and not public.es_admin() then
    raise exception 'Este trato ya está cerrado. Si hay que reabrirlo, pídeselo al administrador.';
  end if;
  return new;
end $$;

create trigger candado_cierre before insert or update on public.clientes
  for each row execute function public._candado_cierre();

-- ============ RPC ============
create or replace function public._ms_ahora() returns bigint language sql stable set search_path = public as $$
  select (extract(epoch from now()) * 1000)::bigint;
$$;

-- Contrato firmado: el empleado del cliente o el admin.
create or replace function public.cerrar_trato(p_cliente text, p_monto numeric, p_fecha text, p_comprobante text, p_contrato text)
returns jsonb language plpgsql security definer set search_path = public, storage as $$
declare
  c record;
  v_por text;
begin
  select id, data, empleado_id into c from public.clientes where id = p_cliente;
  if not found then raise exception 'No encontramos este cliente'; end if;
  if not (public.es_admin() or (c.empleado_id is not null and c.empleado_id = public.mi_empleado())) then
    raise exception 'Solo el vendedor del cliente o el administrador pueden cerrar este trato' using errcode = '42501';
  end if;
  if c.data->>'estado' = 'cerrado' then raise exception 'Este trato ya está cerrado'; end if;
  if coalesce(p_monto, 0) <= 0 then raise exception 'Escribe el monto del pago'; end if;
  if coalesce(p_fecha, '') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'Elige la fecha del pago'; end if;
  if coalesce(p_comprobante, '') = '' or coalesce(p_contrato, '') = '' then
    raise exception 'Sube el comprobante de pago y el contrato firmado';
  end if;
  if split_part(p_comprobante, '/', 1) <> p_cliente or split_part(p_contrato, '/', 1) <> p_cliente
     or (select count(*) from storage.objects where bucket_id = 'documentos' and name in (p_comprobante, p_contrato)) < 2 then
    raise exception 'No encontramos los archivos subidos. Vuelve a subirlos.';
  end if;
  v_por := coalesce(public.mi_empleado(), 'admin');
  perform set_config('ark.cierre', '1', true);
  insert into public.finanzas (id, data) values (gen_random_uuid()::text, jsonb_build_object(
    'tipo', 'ingreso', 'clienteId', p_cliente, 'monto', p_monto, 'fecha', p_fecha,
    'concepto', 'Anticipo · ' || coalesce(c.data->>'empresa', 'cliente'), 'categoria', 'Anticipo de proyecto',
    'metodo', 'Transferencia', 'comprobante', p_comprobante, 'registradoPor', v_por, 'creado', public._ms_ahora()));
  update public.clientes set data = data || jsonb_build_object(
    'estado', 'cerrado', 'actualizado', public._ms_ahora(),
    'cierre', jsonb_build_object('fecha', p_fecha, 'monto', p_monto, 'comprobante', p_comprobante,
                                 'contrato', p_contrato, 'por', v_por, 'registrado', public._ms_ahora()))
  where id = p_cliente;
  perform set_config('ark.cierre', '', true);
  return jsonb_build_object('empresa', c.data->>'empresa',
    'comision', coalesce((select (data->>'porVenta')::numeric from public.config where id = 'bonos'), 0));
end $$;

-- Venta completada: solo el admin, con el comprobante del pago restante.
create or replace function public.completar_venta(p_cliente text, p_monto numeric, p_fecha text, p_comprobante text)
returns void language plpgsql security definer set search_path = public, storage as $$
declare c record;
begin
  if not public.es_admin() then raise exception 'Solo el administrador puede completar la venta' using errcode = '42501'; end if;
  select id, data into c from public.clientes where id = p_cliente;
  if not found then raise exception 'No encontramos este cliente'; end if;
  if c.data->>'estado' <> 'cerrado' then raise exception 'Primero hay que cerrar el trato (contrato firmado)'; end if;
  if c.data ? 'completado' then raise exception 'Esta venta ya está completada'; end if;
  if coalesce(p_monto, 0) < 0 then raise exception 'El monto no puede ser negativo'; end if;
  if coalesce(p_fecha, '') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'Elige la fecha del pago'; end if;
  if coalesce(p_comprobante, '') = '' or split_part(p_comprobante, '/', 1) <> p_cliente
     or not exists (select 1 from storage.objects where bucket_id = 'documentos' and name = p_comprobante) then
    raise exception 'Sube el comprobante del pago restante';
  end if;
  perform set_config('ark.cierre', '1', true);
  if p_monto > 0 then
    insert into public.finanzas (id, data) values (gen_random_uuid()::text, jsonb_build_object(
      'tipo', 'ingreso', 'clienteId', p_cliente, 'monto', p_monto, 'fecha', p_fecha,
      'concepto', 'Liquidación · ' || coalesce(c.data->>'empresa', 'cliente'), 'categoria', 'Pago de proyecto',
      'metodo', 'Transferencia', 'comprobante', p_comprobante, 'registradoPor', 'admin', 'creado', public._ms_ahora()));
  end if;
  update public.clientes set data = data || jsonb_build_object('actualizado', public._ms_ahora(),
    'completado', jsonb_build_object('fecha', p_fecha, 'monto', p_monto, 'comprobante', p_comprobante, 'registrado', public._ms_ahora()))
  where id = p_cliente;
  perform set_config('ark.cierre', '', true);
end $$;

revoke all on function public.cerrar_trato(text, numeric, text, text, text) from public, anon;
revoke all on function public.completar_venta(text, numeric, text, text) from public, anon;
revoke all on function public._candado_cierre() from public, anon, authenticated;
revoke all on function public._ms_ahora() from public, anon;
grant execute on function public.cerrar_trato(text, numeric, text, text, text) to authenticated;
grant execute on function public.completar_venta(text, numeric, text, text) to authenticated;
