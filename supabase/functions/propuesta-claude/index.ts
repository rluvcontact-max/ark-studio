// Genera con Claude (API de Anthropic) la propuesta comercial de un prospecto y la guarda en `propuestas`.
// Usa la Message Batches API: la petición se manda y el resultado se recoge después, así no
// dependemos del límite de 150 s de las Edge Functions (el prompt genera análisis y un JSON con la
// presentación, el guion por diapositiva y las preguntas probables).
//
// POST {"id": "<cliente>"}  → manda a generar (o regenerar) la propuesta de ese cliente.
//   Admin, lead-encuesta (header x-ark-interno) o el vendedor del cliente si aún no hay propuesta o falló.
// POST {}                   → revisa las propuestas pendientes y guarda las que ya terminaron, y vuelve a intentar
//   las de la encuesta que no se pudieron empezar (sin saldo, error temporal). La llama pg_cron cada 5 min (`revisar-propuestas`).
// Desplegada con verify_jwt = true. Necesita el secreto ANTHROPIC_API_KEY.
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import Anthropic from "npm:@anthropic-ai/sdk@0.131";
import { PROMPT_PROPUESTA } from "./prompt.ts";

const MODELO = "claude-opus-5-5";
const URL_SB = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const ORIGENES = ["https://arkdashboardmx.netlify.app"];
const MAX_HORAS = 26; // un batch puede tardar hasta 24 h
const MAX_CONTINUACIONES = 4; // si Claude se pausa a mitad de sus búsquedas (pause_turn)
const REINTENTO_MIN = 30; // cada cuánto se reintenta una propuesta de la encuesta que no se pudo empezar
const REINTENTO_DIAS = 14; // solo prospectos de la encuesta de los últimos días
const REINTENTOS_POR_VUELTA = 3;
// Búsqueda y lectura web (del lado de Anthropic) para analizar el perfil de Google del negocio.
const HERRAMIENTAS: Anthropic.Messages.ToolUnion[] = [
  {
    type: "web_search_20260209", name: "web_search", max_uses: 5,
    user_location: { type: "approximate", country: "MX", region: "Jalisco", city: "Guadalajara", timezone: "America/Mexico_City" },
  },
  { type: "web_fetch_20260209", name: "web_fetch", max_uses: 3 },
];

function cors(origin: string | null) {
  const ok = origin && (ORIGENES.includes(origin) || /^https:\/\/[a-z0-9]+--arkdashboardmx\.netlify\.app$/.test(origin));
  return {
    "Access-Control-Allow-Origin": ok ? origin! : ORIGENES[0],
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Vary": "Origin",
  };
}

// Firma interna para lead-encuesta: sha256 de la service key (nunca viaja la llave).
async function firmaInterna() {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("ark-interno:" + SERVICE));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

const claude = () => new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY") });

function respuestasDe(c: Record<string, unknown>) {
  const t = (v: unknown) => String(v ?? "").trim();
  const e = (c.encuesta ?? {}) as Record<string, unknown>;
  const lineas = Object.keys(e).length
    ? [
      `Negocio: ${t(e.negocio)}`, `Nombre de quien respondió: ${t(e.nombre)}`, `Giro: ${t(e.giro)}`,
      `Sistemas que le interesan: ${t(e.sistemas)}`, `Para quién es la app: ${t(e.usuarios)}`,
      `Plataforma: ${t(e.plataforma)}`, `Para cuándo lo quiere: ${t(e.tiempo)}`, `Comentarios: ${t(e.comentarios)}`,
      `Link del perfil de Google del negocio: ${t(e.google)}`,
    ]
    : [`Negocio: ${t(c.empresa)}`, `Nombre de quien respondió: ${t(c.contacto)}`, t(c.notas)];
  return lineas.filter((l) => !/:\s*$/.test(l)).join("\n");
}

// Manda la conversación como batch. `mensajes` se guarda para poder continuar si hay pause_turn.
async function mandarBatch(id: string, mensajes: Anthropic.Messages.MessageParam[]) {
  return await claude().messages.batches.create({
    requests: [{
      custom_id: id.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64) || "propuesta",
      params: {
        model: MODELO,
        max_tokens: 32000,
        output_config: { effort: "high" },
        system: PROMPT_PROPUESTA,
        tools: HERRAMIENTAS,
        messages: mensajes,
      },
    }],
  });
}

async function solicitar(sb: SupabaseClient, id: string) {
  const { data: fila, error } = await sb.from("clientes").select("data").eq("id", id).single();
  if (error || !fila) throw new Error("Cliente no encontrado");
  // El guion lo lee el vendedor del cliente (o Ricardo si no tiene), así que va con su nombre.
  const cd = fila.data as Record<string, unknown>;
  let vendedor = "Ricardo Lua";
  if (cd.empleadoId) {
    const { data: e } = await sb.from("empleados").select("data").eq("id", String(cd.empleadoId)).maybeSingle();
    const nombre = String((e?.data as Record<string, unknown> | undefined)?.nombre ?? "").trim();
    if (nombre) vendedor = nombre;
  }
  const mensajes: Anthropic.Messages.MessageParam[] = [
    { role: "user", content: `VENDEDOR QUE PRESENTA: ${vendedor}\n\nRESPUESTAS:\n\n` + respuestasDe(cd) },
  ];
  const { data: prev } = await sb.from("propuestas").select("data").eq("id", id).maybeSingle();
  let batch;
  try {
    batch = await mandarBatch(id, mensajes);
  } catch (e) {
    // Que el error se vea en la ficha del cliente (antes no quedaba registro y parecía bloqueado).
    const m = e instanceof Error ? e.message : String(e);
    const error = /credit balance/i.test(m)
      ? "No hay saldo en la cuenta de Anthropic (Claude). Recarga créditos en console.anthropic.com → Plans & Billing y vuelve a generar."
      : "Claude no pudo empezar la propuesta. Intenta de nuevo en un rato.";
    const pd = (prev?.data ?? {}) as Record<string, unknown>;
    await sb.from("propuestas").upsert({ id, data: {
      ...pd, estado: "error", error, mensajes: null,
      reintentar: true, ultimoIntento: Date.now(), intentos: (Number(pd.intentos) || 0) + 1,
    } });
    throw e;
  }
  const { error: e2 } = await sb.from("propuestas").upsert({
    id,
    data: {
      ...(prev?.data ?? {}), estado: "pendiente", batchId: batch.id, solicitada: Date.now(), error: "",
      mensajes, continuaciones: 0, reintentar: false,
    },
  });
  if (e2) throw e2;
}

function separar(texto: string) {
  const bloques = [...texto.matchAll(/```json\s*([\s\S]*?)```/g)];
  let crudo = bloques.length ? bloques[bloques.length - 1][1] : "";
  if (!crudo) {
    const i = texto.indexOf("{", Math.max(0, texto.lastIndexOf("JSON")));
    crudo = i >= 0 ? texto.slice(i, texto.lastIndexOf("}") + 1) : "";
  }
  let datos: Record<string, unknown> | null = null;
  try { datos = JSON.parse(crudo); } catch { datos = null; }
  // El texto para leer empieza en el resumen (sin lo que Claude dijo mientras buscaba) y termina antes del JSON.
  const corte = texto.search(/\n[─\-—=\s]*\n?\s*\d\.\s*JSON/);
  let legible = (corte > 0 ? texto.slice(0, corte) : texto.replace(/```json[\s\S]*?```/g, "")).trim();
  const inicio = legible.search(/[─\-—=]*\s*\n?\s*1\.\s*RESUMEN INTERNO/);
  if (inicio > 0) legible = legible.slice(inicio).trim();
  return { legible, datos };
}

async function revisar(sb: SupabaseClient) {
  const { data: filas, error } = await sb.from("propuestas").select("id,data").eq("data->>estado", "pendiente");
  if (error) throw error;
  const c = claude();
  let listas = 0;
  for (const f of filas ?? []) {
    const d = f.data as Record<string, unknown>;
    const guardar = (extra: Record<string, unknown>) =>
      sb.from("propuestas").update({ data: { ...d, ...extra } }).eq("id", f.id);
    try {
      const batch = await c.messages.batches.retrieve(String(d.batchId));
      if (batch.processing_status !== "ended") {
        if (Date.now() - Number(d.solicitada) > MAX_HORAS * 3600e3) await guardar({ estado: "error", error: "Claude tardó demasiado. Intenta de nuevo." });
        continue;
      }
      for await (const r of await c.messages.batches.results(batch.id)) {
        if (r.result.type !== "succeeded") {
          await guardar({ estado: "error", error: `La petición terminó como "${r.result.type}".`, mensajes: null });
          continue;
        }
        const m = r.result.message;
        if (m.stop_reason === "refusal") { await guardar({ estado: "error", error: "Claude no generó esta propuesta.", mensajes: null }); continue; }
        const previos = ((d.mensajes ?? []) as Anthropic.Messages.MessageParam[]);
        // Claude se pausó a mitad de sus búsquedas: se le regresa su turno tal cual y continúa.
        if (m.stop_reason === "pause_turn") {
          const n = Number(d.continuaciones) || 0;
          if (!previos.length || n >= MAX_CONTINUACIONES) {
            await guardar({ estado: "error", error: "Claude no terminó la propuesta. Intenta de nuevo.", mensajes: null });
            continue;
          }
          const mensajes = [...previos, { role: "assistant" as const, content: m.content }];
          const nuevo = await mandarBatch(f.id, mensajes);
          await guardar({ batchId: nuevo.id, mensajes, continuaciones: n + 1 });
          continue;
        }
        // Texto de todos los turnos de Claude (los pausados y el último).
        const bloques = [
          ...previos.filter((x) => x.role === "assistant").flatMap((x) => Array.isArray(x.content) ? x.content : []),
          ...m.content,
        ];
        const texto = bloques.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("").trim();
        const { legible, datos } = separar(texto);
        await guardar({
          estado: "lista", texto: legible, datos, generada: Date.now(), modelo: m.model, mensajes: null, continuaciones: null,
          error: datos ? "" : "No se pudo leer el JSON; la presentación queda vacía.",
          incompleta: m.stop_reason === "max_tokens",
        });
        listas++;
        // Si el cliente no tiene valor estimado, se toma el precio objetivo (al que se espera cerrar).
        const pr = (datos?.pricing ?? {}) as Record<string, unknown>;
        const precio = Number(pr.target_price_mxn ?? pr.development_price_mxn) || Number(pr.offer_price_mxn) || 0;
        if (precio > 0) {
          const { data: cli } = await sb.from("clientes").select("data").eq("id", f.id).single();
          const cd = (cli?.data ?? {}) as Record<string, unknown>;
          if (cli && !Number(cd.valor)) await sb.from("clientes").update({ data: { ...cd, valor: precio } }).eq("id", f.id);
        }
      }
    } catch (e) {
      console.error("Error revisando la propuesta", f.id, e);
    }
  }
  return { pendientes: (filas ?? []).length, listas, reintentadas: await reintentar(sb) };
}

// La propuesta se crea sola al llegar la encuesta; si no se pudo empezar (sin saldo en Anthropic, error temporal)
// se vuelve a intentar aquí cada REINTENTO_MIN minutos, sin que nadie tenga que picar un botón.
async function reintentar(sb: SupabaseClient) {
  const desde = Date.now() - REINTENTO_DIAS * 864e5;
  const { data: clis } = await sb.from("clientes").select("id,data").eq("data->>origen", "Encuesta");
  const recientes = (clis ?? []).filter((c) => Number((c.data as Record<string, unknown>).creado) > desde);
  if (!recientes.length) return 0;
  const { data: props } = await sb.from("propuestas").select("id,data").in("id", recientes.map((c) => c.id));
  const porId = new Map((props ?? []).map((p) => [p.id, p.data as Record<string, unknown>]));
  const toca = recientes.filter((c) => {
    const p = porId.get(c.id);
    // sin propuesta: solo si ya pasaron 10 min (la encuesta la pide en cuanto llega)
    if (!p) return Date.now() - Number((c.data as Record<string, unknown>).creado) > 10 * 60e3;
    return p.estado === "error" && p.reintentar === true && Date.now() - (Number(p.ultimoIntento) || 0) > REINTENTO_MIN * 60e3;
  }).slice(0, REINTENTOS_POR_VUELTA);
  let n = 0;
  for (const c of toca) {
    try { await solicitar(sb, c.id); n++; } catch (e) { console.error("Reintento de propuesta", c.id, e instanceof Error ? e.message : e); break; }
  }
  return n;
}

Deno.serve(async (req) => {
  const h = cors(req.headers.get("origin"));
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...h, "Content-Type": "application/json" } });
  if (req.method === "OPTIONS") return new Response(null, { headers: h });
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);
  if (!Deno.env.get("ANTHROPIC_API_KEY")) return json({ error: "Falta el secreto ANTHROPIC_API_KEY" }, 500);

  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const sb = createClient(URL_SB, SERVICE);
  try {
    if (body.id) {
      const interno = req.headers.get("x-ark-interno") === await firmaInterna();
      if (!interno) {
        const u = createClient(URL_SB, ANON, { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
        const { data: admin } = await u.rpc("es_admin");
        if (!admin) {
          // El vendedor puede pedirla para sus clientes cuando no hay propuesta o la anterior falló.
          const { data: yo } = await u.rpc("mi_empleado");
          const { data: cli } = await sb.from("clientes").select("data").eq("id", String(body.id)).maybeSingle();
          const { data: pr } = await sb.from("propuestas").select("data").eq("id", String(body.id)).maybeSingle();
          const est = String((pr?.data as Record<string, unknown> | undefined)?.estado ?? "");
          const suyo = yo && cli && (cli.data as Record<string, unknown>).empleadoId === yo;
          if (!suyo || (est && est !== "error")) return json({ error: "Solo el administrador puede volver a generar esta propuesta" }, 403);
        }
      }
      await solicitar(sb, String(body.id));
      return json({ ok: true });
    }
    return json(await revisar(sb));
  } catch (e) {
    console.error(e);
    return json({ error: e instanceof Error ? e.message : "Error" }, 500);
  }
});
