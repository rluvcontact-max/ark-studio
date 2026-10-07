-- Llama a la Edge Function sync-google cada 15 minutos.
-- La llave en el header es la llave pública (anon) del proyecto; la función se protege con verify_jwt.
create extension if not exists pg_cron;
create extension if not exists pg_net;
select cron.schedule(
  'sync-google-calendar',
  '*/15 * * * *',
  $$ select net.http_post(
       url := 'https://tuaxfleudqxmvoicssqw.supabase.co/functions/v1/sync-google',
       headers := '{"Content-Type":"application/json","Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR1YXhmbGV1ZHF4bXZvaWNzc3F3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTEyOTUxMjEsImV4cCI6MjEwNjg3MTEyMX0.GBXnLj1xiPn7GsaXdysfoODsbfGuL-q6FFG78BZLGPQ"}'::jsonb,
       body := '{}'::jsonb,
       timeout_milliseconds := 60000
     ) $$
);
