// Genera con Claude (API de Anthropic) la propuesta comercial de un prospecto y la guarda en `propuestas`.
// Usa la Message Batches API: la petición se manda y el resultado se recoge después, así no
// dependemos del límite de 150 s de las Edge Functions (el prompt genera guion, preguntas y JSON).
//
// POST {"id": "<cliente>"}  → manda a generar (o regenerar) la propuesta de ese cliente.
//   Solo admin (sesión del panel) o lead-encuesta (header x-ark-interno).
// POST {}                   → revisa las propuestas pendientes y guarda las que ya terminaron.
//   La llama pg_cron cada 5 min (`revisar-propuestas`).
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
    ]
    : [`Negocio: ${t(c.empresa)}`, `Nombre de quien respondió: ${t(c.contacto)}`, t(c.notas)];
  return lineas.filter((l) => !/:\s*$/.test(l)).join("\n");
}

async function solicitar(sb: SupabaseClient, id: string) {
  const { data: fila, error } = await sb.from("clientes").select("data").eq("id", id).single();
  if (error || !fila) throw new Error("Cliente no encontrado");
  const batch = await claude().messages.batches.create({
    requests: [{
      custom_id: id.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64) || "propuesta",
      params: {
        model: MODELO,
        max_tokens: 32000,
        output_config: { effort: "high" },
        system: PROMPT_PROPUESTA,
        messages: [{ role: "user", content: "RESPUESTAS:\n\n" + respuestasDe(fila.data as Record<string, unknown>) }],
      },
    }],
  });
  const { data: prev } = await sb.from("propuestas").select("data").eq("id", id).maybeSingle();
  const { error: e2 } = await sb.from("propuestas").upsert({
    id,
    data: { ...(prev?.data ?? {}), estado: "pendiente", batchId: batch.id, solicitada: Date.now(), error: "" },
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
  // El texto para leer termina antes de la sección del JSON.
  const corte = texto.search(/\n[─\-—=\s]*\n?\s*6\.\s*JSON/);
  const legible = (corte > 0 ? texto.slice(0, corte) : texto.replace(/```json[\s\S]*?```/g, "")).trim();
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
          await guardar({ estado: "error", error: `La petición terminó como "${r.result.type}".` });
          continue;
        }
        const m = r.result.message;
        if (m.stop_reason === "refusal") { await guardar({ estado: "error", error: "Claude no generó esta propuesta." }); continue; }
        const texto = m.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("").trim();
        const { legible, datos } = separar(texto);
        await guardar({
          estado: "lista", texto: legible, datos, generada: Date.now(), modelo: m.model,
          error: datos ? "" : "No se pudo leer el JSON; la presentación queda vacía.",
          incompleta: m.stop_reason === "max_tokens",
        });
        listas++;
        // Si el cliente no tiene valor estimado, se toma el precio recomendado.
        const precio = Number((datos?.pricing as Record<string, unknown> | undefined)?.development_price_mxn) || 0;
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
  return { pendientes: (filas ?? []).length, listas };
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
        if (!admin) return json({ error: "Solo el administrador puede generar propuestas" }, 403);
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
