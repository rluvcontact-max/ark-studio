-- App de empleados: notas por negocio, ventas y bonos, ranking, material de ventas y notificaciones push.

-- ============ Notas por cliente (bitácora) ============
-- data: {clienteId, texto, autorNombre, recordatorio (fecha YYYY-MM-DD opcional), hecho (bool)}
create table public.notas (
  id text primary key default gen_random_uuid()::text,
  cliente_id text not null references public.clientes(id) on delete cascade,
  autor uuid default auth.uid(),
  data jsonb not null default '{}'::jsonb,
  creado timestamptz not null default now()
);
create index on public.notas (cliente_id);
alter table public.notas enable row level security;

-- Las ve y agrega el admin o el empleado dueño del cliente; cada quien edita/borra solo las suyas (el admin, todas).
create policy notas_select on public.notas for select to authenticated
  using (public.es_admin() or exists (select 1 from public.clientes c where c.id = notas.cliente_id and c.empleado_id = public.mi_empleado()));
create policy notas_insert on public.notas for insert to authenticated
  with check (autor = auth.uid() and (public.es_admin() or exists (select 1 from public.clientes c where c.id = notas.cliente_id and c.empleado_id = public.mi_empleado())));
create policy notas_update on public.notas for update to authenticated
  using (public.es_admin() or autor = auth.uid()) with check (public.es_admin() or autor = auth.uid());
create policy notas_delete on public.notas for delete to authenticated
  using (public.es_admin() or autor = auth.uid());

alter publication supabase_realtime add table public.notas;

-- ============ Ventas, bonos y ranking ============
-- Una venta cuenta cuando el cliente hace su primer pago (primer ingreso en finanzas con ese clienteId);
-- se atribuye al empleado del cliente y al mes de ese primer pago.
-- Ventas y comisiones pagadas del empleado que llama (no tiene acceso a finanzas).
create or replace function public.mis_ventas() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'ventas', coalesce((select jsonb_agg(jsonb_build_object('clienteId', v.cliente_id, 'empresa', v.empresa, 'fecha', v.fecha) order by v.fecha desc)
                        from (select c.id as cliente_id, c.data->>'empresa' as empresa, min(f.data->>'fecha') as fecha
                              from clientes c join finanzas f on f.data->>'clienteId' = c.id and f.data->>'tipo' = 'ingreso'
                              where c.empleado_id = mi_empleado() group by c.id) v), '[]'::jsonb),
    'pagos', coalesce((select jsonb_agg(jsonb_build_object('fecha', f.data->>'fecha', 'monto', (f.data->>'monto')::numeric) order by f.data->>'fecha' desc)
                       from finanzas f where f.data->>'tipo' = 'egreso' and f.data->>'categoria' = 'Comisiones'
                         and f.data->>'empleadoId' = mi_empleado()), '[]'::jsonb)
  ) where mi_empleado() is not null;
$$;

-- Ventas por empleado en un mes ('YYYY-MM'); solo totales, nunca los clientes de los demás.
create or replace function public.ranking_mes(p_mes text) returns table (empleado_id text, ventas integer)
language sql stable security definer set search_path = public as $$
  select e.id, coalesce(count(v.cliente_id), 0)::int
  from empleados e
  left join (select c.id as cliente_id, c.empleado_id, min(f.data->>'fecha') as fecha
             from clientes c join finanzas f on f.data->>'clienteId' = c.id and f.data->>'tipo' = 'ingreso'
             where coalesce(c.empleado_id, '') <> '' group by c.id, c.empleado_id) v
    on v.empleado_id = e.id and left(v.fecha, 7) = p_mes
  where auth.uid() is not null
  group by e.id;
$$;

-- Ajustes que el equipo puede leer: bonos ({porVenta, escalones:[{ventas, bono}]}) y material de ventas ({items:[{titulo, texto}]}).
create or replace function public.ajustes_equipo() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_object_agg(id, data), '{}'::jsonb) from config
  where id in ('bonos', 'material') and auth.uid() is not null;
$$;

revoke all on function public.mis_ventas() from public, anon;
revoke all on function public.ranking_mes(text) from public, anon;
revoke all on function public.ajustes_equipo() from public, anon;
grant execute on function public.mis_ventas() to authenticated;
grant execute on function public.ranking_mes(text) to authenticated;
grant execute on function public.ajustes_equipo() to authenticated;

insert into public.config (id, data) values
  ('bonos', '{"porVenta": 2000, "escalones": []}'::jsonb),
  ('material', '{"items": []}'::jsonb)
on conflict (id) do nothing;

-- ============ Notificaciones push ============
create table public.push_suscripciones (
  id text primary key default gen_random_uuid()::text,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  empleado_id text default public.mi_empleado(),
  es_admin boolean not null default public.es_admin(),
  endpoint text not null unique,
  data jsonb not null default '{}'::jsonb,
  creado timestamptz not null default now()
);
alter table public.push_suscripciones enable row level security;
create policy push_propias on public.push_suscripciones for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Llaves VAPID (la privada solo la lee el servidor: sin políticas = solo service role).
create table public.push_config (
  id text primary key,
  data jsonb not null default '{}'::jsonb
);
alter table public.push_config enable row level security;
