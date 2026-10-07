// Notificaciones push al celular de los empleados (y del admin).
// POST {"tipo":"prospecto","clienteId":"…"} → "Nuevo prospecto" al vendedor del cliente y a los admins.
//   Solo lead-encuesta (header x-ark-interno = sha256 de la service key).
// POST {}                                   → citas que empiezan en los próximos 35 min (hora de Ciudad de México).
//   La llama pg_cron cada 5 min (`avisar-citas`); cada cita se avisa una sola vez (tabla push_avisos).
// Desplegada con verify_jwt = true. Las llaves VAPID están en la tabla push_config (solo service role).
import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const sb = createClient(Deno.env.get("SUPABASE_URL")!, SERVICE);
const AVISO_MIN = 35;

async function firmaInterna() {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("ark-interno:" + SERVICE));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

let listo = false;
async function vapid() {
  if (listo) return;
  const { data, error } = await sb.from("push_config").select("data").eq("id", "vapid").single();
  if (error || !data) throw new Error("Faltan las llaves VAPID en push_config");
  const d = data.data as Record<string, string>;
  webpush.setVapidDetails(d.subject, d.publicKey, d.privateKey);
  listo = true;
}

type Aviso = { title: string; body: string; url?: string; tag?: string };

// Manda el aviso a las suscripciones del empleado indicado y, si se pide, a las de los admins.
async function enviar(empleadoId: string, admins: boolean, aviso: Aviso) {
  await vapid();
  const filtros = [empleadoId ? `empleado_id.eq.${empleadoId}` : "", admins ? "es_admin.eq.true" : ""].filter(Boolean).join(",");
  if (!filtros) return 0;
  const { data: subs } = await sb.from("push_suscripciones").select("id,data").or(filtros);
  let enviados = 0;
  for (const s of subs ?? []) {
    try {
      await webpush.sendNotification(s.data as webpush.PushSubscription, JSON.stringify(aviso), { TTL: 3600 });
      enviados++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) await sb.from("push_suscripciones").delete().eq("id", s.id); // el celular ya no la usa
      else console.error("Error al enviar push", code, e);
    }
  }
  return enviados;
}

function ahoraMX() {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Mexico_City", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { fecha: `${p.year}-${p.month}-${p.day}`, minutos: Number(p.hour) * 60 + Number(p.minute) };
}

async function avisarCitas() {
  const { fecha, minutos } = ahoraMX();
  const { data: evs, error } = await sb.from("eventos").select("id,data").eq("data->>fecha", fecha);
  if (error) throw error;
  let avisadas = 0;
  for (const ev of evs ?? []) {
    const d = ev.data as Record<string, string>;
    const m = /^(\d{1,2}):(\d{2})/.exec(d.hora || "");
    if (!m || !d.empleadoId) continue;
    const faltan = Number(m[1]) * 60 + Number(m[2]) - minutos;
    if (faltan <= 0 || faltan > AVISO_MIN) continue;
    const { error: dup } = await sb.from("push_avisos").insert({ clave: `cita:${ev.id}:${fecha}:${d.hora}` });
    if (dup) continue; // ya se avisó
    await enviar(d.empleadoId, false, {
      title: `Tu cita empieza en ${faltan} min`, body: `${d.titulo || d.tipo || "Cita"} · ${d.hora}`, url: "/", tag: `cita-${ev.id}`,
    });
    avisadas++;
  }
  return { avisadas };
}

Deno.serve(async (req) => {
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);
  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  try {
    if (body.tipo === "prospecto") {
      if (req.headers.get("x-ark-interno") !== await firmaInterna()) return json({ error: "No autorizado" }, 403);
      const { data: c } = await sb.from("clientes").select("data").eq("id", String(body.clienteId)).single();
      if (!c) return json({ error: "Cliente no encontrado" }, 404);
      const d = c.data as Record<string, string>;
      const enviados = await enviar(d.empleadoId || "", true, {
        title: "Nuevo prospecto", body: `${d.empresa || "Un negocio"} llenó la encuesta${d.contacto ? " · " + d.contacto : ""}`, url: "/", tag: `prospecto-${body.clienteId}`,
      });
      return json({ ok: true, enviados });
    }
    return json(await avisarCitas());
  } catch (e) {
    console.error(e);
    return json({ error: e instanceof Error ? e.message : "Error" }, 500);
  }
});
