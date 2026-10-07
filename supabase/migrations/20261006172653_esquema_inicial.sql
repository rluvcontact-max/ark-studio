-- Perfiles: liga cada usuario de Auth con su rol y su empleado
create table public.perfiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  rol text not null check (rol in ('admin','empleado')),
  empleado_id text,
  usuario text unique not null
);

create table public.empleados (
  id text primary key default gen_random_uuid()::text,
  data jsonb not null default '{}'::jsonb,
  creado timestamptz not null default now()
);

create table public.clientes (
  id text primary key default gen_random_uuid()::text,
  data jsonb not null default '{}'::jsonb,
  empleado_id text generated always as (data->>'empleadoId') stored,
  creado timestamptz not null default now()
);

create table public.eventos (
  id text primary key default gen_random_uuid()::text,
  data jsonb not null default '{}'::jsonb,
  empleado_id text generated always as (data->>'empleadoId') stored,
  creado timestamptz not null default now()
);

create table public.finanzas (
  id text primary key default gen_random_uuid()::text,
  data jsonb not null default '{}'::jsonb,
  creado timestamptz not null default now()
);

create table public.juntas (
  id text primary key default gen_random_uuid()::text,
  data jsonb not null default '{}'::jsonb,
  creado timestamptz not null default now()
);

create table public.config (
  id text primary key,
  data jsonb not null default '{}'::jsonb
);

create index on public.clientes (empleado_id);
create index on public.eventos (empleado_id);

-- Funciones de rol (security definer para evitar recursión en RLS)
create or replace function public.es_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.perfiles where user_id = auth.uid() and rol = 'admin');
$$;

create or replace function public.mi_empleado() returns text
language sql stable security definer set search_path = public as $$
  select empleado_id from public.perfiles where user_id = auth.uid();
$$;

revoke all on function public.es_admin() from public, anon;
revoke all on function public.mi_empleado() from public, anon;
grant execute on function public.es_admin() to authenticated;
grant execute on function public.mi_empleado() to authenticated;

alter table public.perfiles enable row level security;
alter table public.empleados enable row level security;
alter table public.clientes enable row level security;
alter table public.eventos enable row level security;
alter table public.finanzas enable row level security;
alter table public.juntas enable row level security;
alter table public.config enable row level security;

-- perfiles: cada quien lee el suyo; el admin lee todos. Escritura solo vía función de servidor.
create policy perfiles_select on public.perfiles for select to authenticated
  using (user_id = auth.uid() or public.es_admin());

-- empleados: todo el equipo los ve; solo admin escribe
create policy empleados_select on public.empleados for select to authenticated using (true);
create policy empleados_admin on public.empleados for all to authenticated
  using (public.es_admin()) with check (public.es_admin());

-- clientes y eventos: admin todo; empleado solo lo suyo
create policy clientes_admin on public.clientes for all to authenticated
  using (public.es_admin()) with check (public.es_admin());
create policy clientes_propios on public.clientes for all to authenticated
  using (empleado_id = public.mi_empleado()) with check (empleado_id = public.mi_empleado());

create policy eventos_admin on public.eventos for all to authenticated
  using (public.es_admin()) with check (public.es_admin());
create policy eventos_propios on public.eventos for all to authenticated
  using (empleado_id = public.mi_empleado()) with check (empleado_id = public.mi_empleado());

-- solo admin
create policy finanzas_admin on public.finanzas for all to authenticated
  using (public.es_admin()) with check (public.es_admin());
create policy juntas_admin on public.juntas for all to authenticated
  using (public.es_admin()) with check (public.es_admin());
create policy config_admin on public.config for all to authenticated
  using (public.es_admin()) with check (public.es_admin());

-- tiempo real
alter publication supabase_realtime add table public.empleados, public.clientes, public.eventos, public.finanzas, public.juntas, public.config, public.perfiles;
