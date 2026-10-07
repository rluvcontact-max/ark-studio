# Sincronizar juntas de Grain con ARK Studio

Tarea programada de Claude: **"Sincronizar juntas de Grain con ARK Studio"**, cada hora al minuto 41, corre en la nube con los conectores de Grain y Supabase. Se administra en Claude (tareas programadas). Este es su prompt actual:

---

Sincroniza las grabaciones nuevas de Grain con la sección "Juntas" de la app ARK Studio (base de datos Supabase). Trabaja en silencio; solo escribe datos.

Herramientas: conector de Grain (mcp__Grain__*) y conector de Supabase (mcp__Supabase__execute_sql) con project_id = "tuaxfleudqxmvoicssqw". Cárgalas con ToolSearch si hace falta.

Tablas (todas con columnas id text, data jsonb): empleados (data.nombre, data.email), clientes (data.empresa, data.contacto, data.email, data.empleadoId), eventos (data.fecha "YYYY-MM-DD", data.hora "HH:MM", data.empleadoId, data.clienteId, data.titulo, data.grabacion), juntas, config.

Pasos:
1. Lee el estado: select data from public.config where id='sync'. Su campo ultimoInicio es la fecha ISO de la junta más reciente ya sincronizada; si no existe usa las últimas 48 horas.
2. mcp__Grain__list_meetings con filters.after_datetime = ultimoInicio, limit 20; sigue el cursor hasta terminar. Descarta las que ya existan: select id from public.juntas where id in (...).
3. Lee catálogos: select id, data->>'nombre', data->>'email' from public.empleados; select id, data->>'empresa', data->>'contacto', data->>'email' from public.clientes; y los eventos de las fechas involucradas.
4. Para cada junta nueva arma el JSON de data:
   - titulo, inicio (start_datetime ISO), duracion ("hh:mm:ss"), url (recording_url), origen "grain".
   - fecha y hora en hora de Ciudad de México (UTC-6): "YYYY-MM-DD" y "HH:MM".
   - participantes: nombres sin bots/notetakers (que contengan "Notetaker", "Fathom", "Grain" o "bot").
   - resumen: el summary de Grain en español, 2-3 oraciones ("" si no hay).
   - empleadoIds: ids de empleados que participaron (por email o nombre+apellido, sin acentos ni mayúsculas). Ricardo Lua NO es empleado.
   - clienteId: cliente cuyo contacto/email coincide con un participante o cuya empresa aparece en el título; si no, "".
   Inserta con: insert into public.juntas (id, data) values ('<id grain>', $j$<json>$j$::jsonb) on conflict (id) do nothing;
5. Para cada junta con empleado, busca un evento de ese empleado misma fecha y hora a ±90 min (o mismo cliente ese día) sin data.grabacion, y actualiza: update public.eventos set data = data || jsonb_build_object('grabacion', '<url>', 'juntaId', '<id>') where id = '<evento>';
6. Actualiza el estado: insert into public.config (id, data) values ('sync', jsonb_build_object('ultima', <epoch ms ahora>, 'ultimoInicio', '<start_datetime más reciente procesado o el anterior>')) on conflict (id) do update set data = excluded.data;
7. Responde en una línea cuántas juntas se agregaron y cuántas citas se marcaron como grabadas. Si Grain o Supabase fallan, dilo en una línea y termina sin reintentar en bucle.

Nunca borres registros ni toques las tablas finanzas, perfiles ni las cuentas de usuario.

---

Si se quiere sacar de Claude, se puede reemplazar por una Edge Function con la API de Grain (requiere token de Grain como secreto en Supabase).
