// Recibe las respuestas de la encuesta pública (arkencuesta.netlify.app)
// y las registra como cliente 'prospecto' asignado al vendedor del link (?v=...).
// Desplegada con verify_jwt = false (es pública; valida origen, honeypot y datos).
// Después de responder pide a propuesta-claude que Claude prepare la propuesta comercial
// (si falla, el prospecto queda registrado igual).
import { createClient } from "npm:@supabase/supabase-js@2";

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

// Firma interna que propuesta-claude reconoce (sha256 de la service key; la llave no viaja).
async function firmaInterna() {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("ark-interno:" + Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function pedirPropuesta(id: string) {
  try {
    const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
    const r = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/propuesta-claude`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${anon}`, apikey: anon, "x-ark-interno": await firmaInterna() },
      body: JSON.stringify({ id }),
    });
    if (!r.ok) console.error("propuesta-claude respondió", r.status, await r.text());
  } catch (e) {
    console.error("No se pudo pedir la propuesta", e);
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
      encuesta: {
        negocio, nombre, giro: txt(b.giro), sistemas: txt(b.sistemas, 1500), usuarios: txt(b.usuarios),
        plataforma, tiempo: txt(b.tiempo), comentarios: txt(b.comentarios, 1500),
      },
    },
  }).select("id").single();
  if (error) { console.error(error); return new Response("No se pudo guardar", { status: 500, headers: h }); }

  EdgeRuntime.waitUntil(pedirPropuesta(nuevo.id));
  return new Response(JSON.stringify({ ok: true }), { headers: { ...h, "Content-Type": "application/json" } });
});
