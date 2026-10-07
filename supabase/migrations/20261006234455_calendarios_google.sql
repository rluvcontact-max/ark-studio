-- Direcciones secretas iCal de Google Calendar por empleado (solo las lee el servidor)
create table if not exists public.calendarios_google (
  empleado_id text primary key,
  ical_url text not null,
  ultima_sync timestamptz,
  ultimo_error text
);
alter table public.calendarios_google enable row level security;
revoke all on public.calendarios_google from anon, authenticated;
-- sin políticas: solo el service role (Edge Functions) puede leerla

-- El admin puede ver el estado de sincronización (sin la URL)
create or replace view public.calendarios_google_estado with (security_invoker = false) as
  select empleado_id, ultima_sync, ultimo_error from public.calendarios_google where public.es_admin();
revoke all on public.calendarios_google_estado from anon;
grant select on public.calendarios_google_estado to authenticated;
