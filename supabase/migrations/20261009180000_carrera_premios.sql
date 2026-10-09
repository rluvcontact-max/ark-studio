-- Carrera de premios: el primer empleado en llegar a N ventas acumuladas (desde `inicio`) gana el premio.
-- Una venta es el primer ingreso en finanzas de un cliente (igual que en bonos), atribuida al empleado del cliente.
-- config id 'premios': {inicio: 'YYYY-MM-DD', premios: [{ventas, premio, emoji}]}. Lo edita el admin.

insert into public.config (id, data) values ('premios', jsonb_build_object(
  'inicio', '2026-10-09',
  'premios', jsonb_build_array(
    jsonb_build_object('ventas', 10, 'premio', 'AirPods Pro', 'emoji', '🎧'),
    jsonb_build_object('ventas', 25, 'premio', 'iPhone 18 Pro Max', 'emoji', '📱'),
    jsonb_build_object('ventas', 50, 'premio', 'MacBook Pro', 'emoji', '💻'),
    jsonb_build_object('ventas', 100, 'premio', 'Mercedes-Benz CLA 180', 'emoji', '🚗')
  )
)) on conflict (id) do nothing;

-- Regresa {inicio, premios:[{ventas, premio, emoji, ganador, fecha}], tabla:[{empleado_id, ventas, ultima}]}.
-- Solo totales y fechas: nunca los clientes ni los montos de nadie.
create or replace function public.carrera_premios() returns jsonb
language sql stable security definer set search_path = public as $$
  with cfg as (
    select coalesce((select data from config where id = 'premios'), '{}'::jsonb) as d
  ),
  pagos as ( -- ingresos con cliente, en orden, para quedarse con el primero de cada cliente
    select c.id as cliente_id, c.empleado_id, f.data->>'fecha' as fecha, f.creado,
           row_number() over (partition by c.id order by f.data->>'fecha', f.creado) as k
    from clientes c join finanzas f on f.data->>'clienteId' = c.id and f.data->>'tipo' = 'ingreso'
    where coalesce(c.empleado_id, '') <> '' and coalesce(f.data->>'fecha', '') <> ''
  ),
  ventas as ( -- ventas dentro de la competencia, numeradas por empleado en el orden en que se cerraron
    select p.empleado_id, p.fecha, p.creado,
           row_number() over (partition by p.empleado_id order by p.fecha, p.creado) as n
    from pagos p, cfg
    where p.k = 1 and p.fecha >= coalesce(cfg.d->>'inicio', '0000-00-00')
  ),
  premios as (
    select (x->>'ventas')::int as meta, x->>'premio' as premio, coalesce(x->>'emoji', '') as emoji
    from cfg, jsonb_array_elements(coalesce(cfg.d->'premios', '[]'::jsonb)) x
    where coalesce(x->>'ventas', '') ~ '^[0-9]+$'
  ),
  ganadores as ( -- quien llegó primero a la meta (por fecha de su venta número N; empate: quien la registró antes)
    select distinct on (pr.meta) pr.meta, v.empleado_id, v.fecha
    from premios pr join ventas v on v.n = pr.meta
    order by pr.meta, v.fecha, v.creado
  )
  select jsonb_build_object(
    'inicio', (select d->>'inicio' from cfg),
    'premios', coalesce((
      select jsonb_agg(jsonb_build_object('ventas', pr.meta, 'premio', pr.premio, 'emoji', pr.emoji,
                                          'ganador', g.empleado_id, 'fecha', g.fecha) order by pr.meta)
      from premios pr left join ganadores g on g.meta = pr.meta), '[]'::jsonb),
    'tabla', coalesce((
      select jsonb_agg(jsonb_build_object('empleado_id', e.id, 'ventas', coalesce(t.ventas, 0), 'ultima', t.ultima))
      from empleados e
      left join (select empleado_id, count(*)::int as ventas, max(fecha) as ultima from ventas group by empleado_id) t
        on t.empleado_id = e.id), '[]'::jsonb)
  ) where auth.uid() is not null or auth.role() = 'service_role'; -- service role: la función notificar avisa a quién ganó
$$;

revoke all on function public.carrera_premios() from public, anon;
grant execute on function public.carrera_premios() to authenticated, service_role;
