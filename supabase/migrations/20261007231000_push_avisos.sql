-- Avisos push ya enviados (para no repetir el de una misma cita). Solo el servidor la usa.
create table public.push_avisos (
  clave text primary key,
  creado timestamptz not null default now()
);
alter table public.push_avisos enable row level security;

-- Cada 5 minutos: avisa por push de las citas que empiezan en los próximos 35 minutos.
-- La llave es la pública (anon); la función se protege con verify_jwt.
select cron.schedule(
  'avisar-citas',
  '*/5 * * * *',
  $$ select net.http_post(
       url := 'https://tuaxfleudqxmvoicssqw.supabase.co/functions/v1/notificar',
       headers := '{"Content-Type":"application/json","Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR1YXhmbGV1ZHF4bXZvaWNzc3F3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTEyOTUxMjEsImV4cCI6MjEwNjg3MTEyMX0.GBXnLj1xiPn7GsaXdysfoODsbfGuL-q6FFG78BZLGPQ"}'::jsonb,
       body := '{}'::jsonb,
       timeout_milliseconds := 30000
     ) $$
);
