// Recibe las respuestas de la encuesta pública (arkencuesta-mx.netlify.app)
// y las registra como cliente 'prospecto' asignado al vendedor del link (?v=...).
// Desplegada con verify_jwt = false (es pública; valida honeypot y datos).
// Después de responder pide a propuesta-claude que Claude prepare la propuesta comercial y a
// notificar que avise por push al vendedor (si algo falla, el prospecto queda registrado igual).
// Desde oct 2026 la encuesta también manda tamaño, sucursales, usuarios al mes, diseño, integraciones, objetivos,
// presupuesto (opcional), el nivel de complejidad de cada sistema (texto `complejidad`) y `cotizacion`: un JSON
// estructurado para el cotizador automático futuro. Todo se guarda en data.encuesta.
import { createClient } from "npm:@supabase/supabase-js@2";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

const VENDEDORES: Record<string, string> = {
  andres: "andres-mayo",
  patricio: "patricio-schnabel",
  guillermo: "guillermo-munoz",
  juanpablo: "juan-pablo-suro",
  jorge: "jorge-torres",
  bruno: "bruno-rodriguez",
};

// Acepta cualquier origen: la encuesta puede publicarse en otra cuenta o dominio de Netlify (p. ej. al cambiar de cuenta)
// y el endpoint es público de todos modos; lo que lo protege es el honeypot y la validación de datos.
function cors(origin: string | null) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
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

async function llamarInterna(funcion: string, body: Record<string, unknown>) {
  try {
    const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
    const r = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/${funcion}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${anon}`, apikey: anon, "x-ark-interno": await firmaInterna() },
      body: JSON.stringify(body),
    });
    if (!r.ok) console.error(`${funcion} respondió`, r.status, await r.text());
  } catch (e) {
    console.error(`No se pudo llamar a ${funcion}`, e);
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

  // Link del perfil de Google del negocio (opcional): solo se acepta http(s).
  const google = /^https?:\/\/\S+$/i.test(txt(b.google, 500)) ? txt(b.google, 500) : "";

  // cotizacion: JSON de la encuesta con los datos estructurados (se guarda tal cual si es válido y no es enorme)
  let cotizacion: unknown = null;
  try { const c = txt(b.cotizacion, 40000); cotizacion = c ? JSON.parse(c) : null; } catch { cotizacion = null; }
  const extra = {
    tamano: txt(b.tamano), sucursales: txt(b.sucursales), usuarios_mes: txt(b.usuarios_mes), diseno: txt(b.diseno),
    integraciones: txt(b.integraciones, 400), integraciones_cual: txt(b.integraciones_cual, 300),
    objetivos: txt(b.objetivos, 400), objetivo_otro: txt(b.objetivo_otro, 300), presupuesto: txt(b.presupuesto),
    complejidad: txt(b.complejidad, 4000), fecha: txt(b.fecha, 40),
  };

  const notas = [
    "Llegó por la encuesta" + (empleadoId ? "" : " (link general)") + ".",
    `Giro: ${txt(b.giro)}`,
    `Sistemas que le interesan: ${txt(b.sistemas, 1500)}`,
    `Para quién: ${txt(b.usuarios)}`,
    `Plataforma: ${txt(b.plataforma)}`,
    `Lo quiere: ${txt(b.tiempo)}`,
    extra.tamano ? `Tamaño: ${extra.tamano} · ${extra.sucursales} · ${extra.usuarios_mes} usuarios al mes` : "",
    extra.diseno ? `Diseño: ${extra.diseno}` : "",
    extra.presupuesto ? `Presupuesto: ${extra.presupuesto}` : "",
    google ? `Google: ${google}` : "",
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
      origen: "Encuesta", google, giro: txt(b.giro), sistemas: txt(b.sistemas, 1500), tiempo: txt(b.tiempo),
      creado: ahora, actualizado: ahora,
      encuesta: {
        negocio, nombre, google, giro: txt(b.giro), sistemas: txt(b.sistemas, 1500), usuarios: txt(b.usuarios),
        plataforma, tiempo: txt(b.tiempo), comentarios: txt(b.comentarios, 1500),
        ...Object.fromEntries(Object.entries(extra).filter(([, v]) => v)),
        ...(cotizacion ? { cotizacion } : {}),
      },
    },
  }).select("id").single();
  if (error) { console.error(error); return new Response("No se pudo guardar", { status: 500, headers: h }); }

  EdgeRuntime.waitUntil(Promise.all([
    llamarInterna("propuesta-claude", { id: nuevo.id }),
    llamarInterna("notificar", { tipo: "prospecto", clienteId: nuevo.id }),
  ]));
  return new Response(JSON.stringify({ ok: true }), { headers: { ...h, "Content-Type": "application/json" } });
});
