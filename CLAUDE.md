# ARK Studio

Sistema interno de **ARK** (empresa de Ricardo Lua que desarrolla apps a la medida, Guadalajara, MX).
Todo el producto está en **español de México**: textos, mensajes de error, comentarios y commits.

## Qué es

- **Panel de administración** (solo Ricardo): Panel, Finanzas (ingresos/egresos/analíticas), Clientes, Calendario, Juntas (grabaciones de Grain), Equipo (empleados, fotos, comisiones, usuarios y contraseñas).
- **App de empleados** (más sencilla): Inicio, Mis clientes, Mi agenda, y su link de encuesta.
- **Encuesta pública** (`encuesta/`) para prospectos; al final agendan una llamada en el Google Calendar del vendedor.
- Estilo visual: blanco o negro con efecto *liquid glass* de Apple. Logo ARK (montaña de línea + "ARK" espaciado). No cambiar la estética sin pedirlo.

## Arquitectura

| Pieza | Dónde vive | Notas |
|---|---|---|
| App (admin + empleados) | `web/index.html` → Netlify **arkdashboardmx** (`https://arkdashboardmx.netlify.app`) | Un solo HTML con CSS y JS en línea, sin build. PWA instalable (`manifest.webmanifest`, `sw.js`, íconos). |
| Encuesta | `encuesta/index.html` → Netlify **arkencuesta** (`https://arkencuesta.netlify.app`) | Un solo HTML. Usa Netlify Forms (`encuesta-app`). Link por vendedor: `?v=clave`. |
| Base de datos y login | Supabase, proyecto **ark-studio**, ref `tuaxfleudqxmvoicssqw`, región us-west-1 | Postgres + Auth + Realtime + Edge Functions + pg_cron. |
| Grabaciones | Grain (workspace de Ricardo, plan gratis hoy) | Sincroniza a la tabla `juntas` una tarea programada de Claude (ver `automatizaciones/`). |

Deploys: hoy se hacen arrastrando la carpeta a Netlify (Deploys → drag & drop). `netlify.toml` publica `web/`. Lo ideal es conectar este repo a Netlify para deploy automático.

## Supabase

- URL: `https://tuaxfleudqxmvoicssqw.supabase.co`
- La llave **anon** (pública) está en `web/index.html`; es normal que esté en el cliente. **Nunca** poner la service role key en el front ni en el repo.
- Patrón de tablas: casi todas tienen `id text`, `data jsonb` y `creado`. El front trabaja con objetos planos `{id, ...data}`. `clientes` y `eventos` tienen la columna generada `empleado_id = data->>'empleadoId'` para las reglas RLS.
- Tablas: `perfiles` (user_id → rol `admin|empleado`, empleado_id, usuario), `empleados`, `clientes`, `eventos`, `finanzas`, `juntas`, `config` (`sync` de Grain, `reservas`), `calendarios_google` (iCal secreto por empleado, solo service role), `propuestas` (id = cliente; propuesta de Claude, la lee el admin o el empleado del cliente, solo escribe el servidor).
- **RLS** (ver `supabase/migrations/`):
  - admin (`es_admin()`) ve y escribe todo.
  - empleado: solo `clientes`/`eventos` con su `empleado_id` (`mi_empleado()`); lee `empleados`; nunca `finanzas`, `juntas`, `config`.
  - anon: nada, salvo las RPC públicas `reserva_*`/`reservar` (hoy sin uso).
- **Cuentas**: Supabase Auth con email/contraseña. Los empleados entran con usuario corto; el front y `_email_de()` lo convierten a `<usuario>@arkstudio.app`. Ricardo entra con su correo. Crear/cambiar/quitar cuentas: RPC `admin_guardar_acceso(p_empleado, p_usuario, p_password)` y `admin_quitar_acceso(p_empleado)` (solo admin).
- **Edge Functions** (`supabase/functions/`):
  - `sync-google` (verify_jwt): lee el iCal secreto de cada empleado y hace upsert de sus citas en `eventos` con id `gcal-…`, `origen: "google"`. La llama pg_cron cada 15 min (`sync-google-calendar`).
  - `lead-encuesta` (sin JWT, CORS solo arkencuesta): registra un prospecto en `clientes` según `?v=`. La encuesta la llama (función `enviarLead`) justo después de enviar a Netlify Forms; si falla, la encuesta sigue igual. Guarda las respuestas en `data.encuesta` (incluido el link opcional del perfil de Google, `google`) y, después de responder, pide a `propuesta-claude` la propuesta comercial.
  - `propuesta-claude` (verify_jwt): con `{id}` manda a Claude (API de Anthropic, Message Batches, `claude-opus-5-5`) el prompt de propuesta de Ricardo (`prompt.ts`) con las respuestas de la encuesta; solo admin o `lead-encuesta` (header `x-ark-interno` = sha256 de la service key). Con `{}` recoge los batches terminados y guarda resumen, alcance, tres precios (objetivo, oferta y mínimo aceptable: `pricing.target_price_mxn`, `offer_price_mxn`, `minimum_acceptable_price_mxn`; las propuestas viejas traen `development_price_mxn`/`minimum_negotiation_price_mxn`), guion, preguntas y el JSON en `propuestas`; si el cliente no tenía valor, pone el precio objetivo. La presentación muestra el precio objetivo. La llama pg_cron cada 5 min (`revisar-propuestas`). Claude usa `web_search`/`web_fetch` para analizar el perfil de Google del negocio (sobre todo para el presupuesto) y lo regresa en `datos.google_profile`; si se pausa (`pause_turn`) se continúa con otro batch guardando la conversación en `data.mensajes`. Necesita el secreto `ANTHROPIC_API_KEY` (llave de un workspace de la consola de Anthropic).
- Después de cambios de esquema, revisar los avisos de seguridad (Supabase → Advisors).

## Empleados y claves

| empleado_id | Clave de encuesta (`?v=`) | Usuario de la app |
|---|---|---|
| andres-mayo | andres | a_mayo |
| patricio-schnabel | patricio | p_schnabel |
| guillermo-munoz | guillermo | g_munoz |
| juan-pablo-suro | juanpablo | j_suro |
| jorge-torres | jorge | j_torres |
| bruno-rodriguez | bruno | b_rodriguez |

Las claves deben coincidir en tres lugares: `EQUIPO` en `encuesta/index.html`, `VENDEDORES` en `lead-encuesta` y `CLAVES_ENCUESTA` en `web/index.html`. Las contraseñas no se guardan en el repo.

## Automatizaciones externas

- **Grain → juntas**: tarea programada de Claude (cada hora, minuto 41). Instrucciones en `automatizaciones/sincronizar-grain.md`. Grain está configurado para grabar todas las juntas del calendario con bot, compartir con el workspace y no permitir desactivarlo. En el plan gratis solo Ricardo puede grabar; los empleados necesitan asiento pago (Starter).
- **Google Calendar → eventos**: pg_cron + `sync-google` (arriba). Cada empleado tiene su página de reservas de Google en `EQUIPO` de la encuesta.

## Convenciones

- Sin frameworks ni build: HTML/CSS/JS en línea, `supabase-js` v2 desde jsDelivr. Mantenerlo así salvo que se decida migrar.
- Antes de entregar cambios en el front: revisar que el `<script>` no tenga errores de sintaxis y probar login admin, login empleado, alta de cliente y de cita.
- Zona horaria del negocio: `America/Mexico_City`.
- Dinero en MXN.

## Archivos

- `web/` — la app (se publica en arkdashboardmx). En la ficha del cliente, "Ver propuesta" abre un recorrido de 3 pasos: Negocio (emoji del giro, link de Google y datos que encontró Claude) → Propuesta → Presentación. `web/propuesta.html?id=<cliente>` (con `&embed=1` dentro de la app) muestra la presentación comercial llenada con la propuesta de Claude (plantilla en `web/propuesta/plantilla.js`, copiada de la deck "ARK — Plantilla de Propuesta" de claude.ai; condiciones de pago, IVA y vigencia en `CONDICIONES` de esa página).
- `encuesta/` — la encuesta (se publica en arkencuesta).
- `supabase/migrations/` — esquema completo, en orden.
- `supabase/functions/` — Edge Functions desplegadas.
- `automatizaciones/` — tarea de Grain.
- `referencia/` — versiones anteriores (la de Claude Artifacts y la página de reservas propia que se descartó). No se publican.
