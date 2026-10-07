-- Propuestas comerciales generadas por Claude (Edge Function propuesta-claude).
-- id = id del cliente. data: {estado: pendiente|lista|error, batchId, solicitada, generada,
-- texto (resumen, alcance, precio, guion, preguntas), datos (JSON con pricing y variables de la presentación), error}.
create table public.propuestas (
  id text primary key references public.clientes(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  creado timestamptz not null default now()
);

alter table public.propuestas enable row level security;

-- admin ve todas; el empleado solo las de sus clientes. Solo el servidor (service role) escribe.
create policy propuestas_select on public.propuestas for select to authenticated
  using (
    public.es_admin()
    or exists (select 1 from public.clientes c where c.id = propuestas.id and c.empleado_id = public.mi_empleado())
  );

alter publication supabase_realtime add table public.propuestas;

-- Recoge cada 5 minutos las propuestas que Claude ya terminó (Message Batches API).
-- La llave es la pública (anon); la función se protege con verify_jwt y solo lee resultados pendientes.
select cron.schedule(
  'revisar-propuestas',
  '*/5 * * * *',
  $$ select net.http_post(
       url := 'https://tuaxfleudqxmvoicssqw.supabase.co/functions/v1/propuesta-claude',
       headers := '{"Content-Type":"application/json","Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR1YXhmbGV1ZHF4bXZvaWNzc3F3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTEyOTUxMjEsImV4cCI6MjEwNjg3MTEyMX0.GBXnLj1xiPn7GsaXdysfoODsbfGuL-q6FFG78BZLGPQ"}'::jsonb,
       body := '{}'::jsonb,
       timeout_milliseconds := 60000
     ) $$
);
