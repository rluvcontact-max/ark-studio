// Recibe las respuestas de la encuesta pública (arkencuesta.netlify.app)
// y las registra como cliente 'prospecto' asignado al vendedor del link (?v=...).
// Desplegada con verify_jwt = false (es pública; valida origen, honeypot y datos).
// Si existe el secreto ANTHROPIC_API_KEY, después de responder le pide a Claude
// un análisis del prospecto y lo agrega a sus notas (si falla, el prospecto queda igual).
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import Anthropic from "npm:@anthropic-ai/sdk@0.131";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

const ORIGENES = ["https://arkencuesta.netlify.app"];
const VENDEDORES: Record<string, string> = {
  andres: "andres-mayo",
  patricio: "patricio-schnabel",
  guillermo: "guillermo-munoz",
  juanpablo: "juan-pablo-suro",
  jorge: "jorge-torres",
  bruno: "bruno-rodriguez",
};

function cors(origin: string | null) {
  const ok = origin && (ORIGENES.includes(origin) || /^https:\/\/[a-z0-9]+--arkencuesta\.netlify\.app$/.test(origin));
  return {
    "Access-Control-Allow-Origin": ok ? origin! : ORIGENES[0],
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Vary": "Origin",
  };
}
const txt = (v: unknown, max = 300) => String(v ?? "").trim().slice(0, max);

const INSTRUCCIONES = `Eres el asistente comercial de ARK, empresa de Guadalajara que desarrolla apps a la medida.
Te paso las respuestas que un prospecto dio en nuestra encuesta. Escribe un análisis breve para el vendedor
que lo va a llamar, en español de México, en texto plano (sin markdown, sin asteriscos ni #), con estas partes:
Resumen: 2 o 3 líneas de quién es y qué necesita.
App sugerida: qué tipo de sistema le conviene y por qué.
Alcance inicial: de 3 a 5 funciones clave para una primera versión, una por línea empezando con "- ".
Preguntas para la llamada: 3 preguntas concretas para entender mejor el proyecto, una por línea con "- ".
Prioridad: Alta, Media o Baja, con una frase de por qué (urgencia y qué tan claro tiene lo que quiere).
No inventes datos que no estén en las respuestas ni des precios.`;

async function analizarConClaude(sb: SupabaseClient, id: string, respuestas: string) {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return;
  try {
    const claude = new Anthropic({ apiKey });
    const r = await claude.beta.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 8000,
      output_config: { effort: "medium" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: INSTRUCCIONES,
      messages: [{ role: "user", content: respuestas }],
    } as Anthropic.Beta.Messages.MessageCreateParamsNonStreaming);
    if (r.stop_reason === "refusal") { console.warn("Claude no generó el análisis", r.stop_details); return; }
    const analisis = r.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("").trim();
    if (!analisis) return;

    const { data: fila, error } = await sb.from("clientes").select("data").eq("id", id).single();
    if (error || !fila) { console.error(error); return; }
    const d = fila.data as Record<string, unknown>;
    const notas = `${txt(d.notas, 20000)}\n\n— Análisis de Claude —\n${analisis}`;
    const { error: e2 } = await sb.from("clientes").update({ data: { ...d, notas, analisisIA: analisis } }).eq("id", id);
    if (e2) console.error(e2);
  } catch (e) {
    console.error("Error al pedir el análisis a Claude", e);
  }
}

Deno.serve(async (req) => {
  const h = cors(req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response(null, { headers: h });
  if (req.method !== "POST") return new Response("Método no permitido", { status: 405, headers: h });

  let b: Record<string, unknown>;
  try { b = await req.json(); } catch { return new Response("JSON inválido", { status: 400, headers: h }); }

  if (txt(b["bot-field"])) return new Response(JSON.stringify({ ok: true }), { headers: { ...h, "Content-Type": "application/json" } });

  const negocio = txt(b.negocio, 120), nombre = txt(b.nombre, 120), whatsapp = txt(b.whatsapp, 40);
  if (!negocio || !nombre || whatsapp.replace(/\D/g, "").length < 10) {
    return new Response("Faltan datos", { status: 400, headers: h });
  }
  const clave = txt(b.v, 40).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "");
  const empleadoId = VENDEDORES[clave] || "";

  const notas = [
    "Llegó por la encuesta" + (empleadoId ? "" : " (link general)") + ".",
    `Giro: ${txt(b.giro)}`,
    `Sistemas que le interesan: ${txt(b.sistemas, 1500)}`,
    `Para quién: ${txt(b.usuarios)}`,
    `Plataforma: ${txt(b.plataforma)}`,
    `Lo quiere: ${txt(b.tiempo)}`,
    txt(b.comentarios, 1500) ? `Comentarios: ${txt(b.comentarios, 1500)}` : "",
  ].filter(Boolean).join("\n");

  const plataforma = txt(b.plataforma);
  const tipoApp = /iphone|android/i.test(plataforma) ? "App móvil" : /web/i.test(plataforma) ? "Web app" : "";

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const ahora = Date.now();
  const { data: nuevo, error } = await sb.from("clientes").insert({
    data: {
      empresa: negocio, contacto: nombre, telefono: whatsapp, email: txt(b.correo, 160),
      empleadoId, estado: "prospecto", tipoApp, valor: 0, notas,
      origen: "Encuesta", giro: txt(b.giro), sistemas: txt(b.sistemas, 1500), tiempo: txt(b.tiempo),
      creado: ahora, actualizado: ahora,
    },
  }).select("id").single();
  if (error) { console.error(error); return new Response("No se pudo guardar", { status: 500, headers: h }); }

  const respuestas = [`Negocio: ${negocio}`, `Contacto: ${nombre}`, notas].join("\n");
  EdgeRuntime.waitUntil(analizarConClaude(sb, nuevo.id, respuestas));
  return new Response(JSON.stringify({ ok: true }), { headers: { ...h, "Content-Type": "application/json" } });
});
