// Sincroniza las citas de Google Calendar de cada empleado (dirección secreta iCal)
// hacia la tabla `eventos` de ARK Studio, asignadas a ese empleado.
// Lo llama un cron cada 15 min. Es idempotente.
import { createClient } from "npm:@supabase/supabase-js@2";

const TZ = "America/Mexico_City";
const DIAS_ATRAS = 30, DIAS_ADELANTE = 120;

function unfold(ics: string) { return ics.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, ""); }
function unesc(s: string) { return s.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1"); }

type Prop = { params: Record<string, string>; value: string };
function parseEvents(ics: string) {
  const out: Record<string, Prop[]>[] = [];
  let cur: Record<string, Prop[]> | null = null;
  for (const line of unfold(ics).split("\n")) {
    if (line === "BEGIN:VEVENT") { cur = {}; continue; }
    if (line === "END:VEVENT") { if (cur) out.push(cur); cur = null; continue; }
    if (!cur) continue;
    const i = line.indexOf(":"); if (i < 0) continue;
    const [name, ...ps] = line.slice(0, i).split(";");
    const params: Record<string, string> = {};
    for (const p of ps) { const [k, v] = p.split("="); params[k.toUpperCase()] = (v || "").replace(/"/g, ""); }
    (cur[name.toUpperCase()] ||= []).push({ params, value: line.slice(i + 1) });
  }
  return out;
}

// Convierte DTSTART/DTEND a {fecha, hora, ms} en hora de México
function partsInTZ(d: Date) {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  const o: Record<string, string> = {};
  for (const p of f.formatToParts(d)) o[p.type] = p.value;
  return { fecha: `${o.year}-${o.month}-${o.day}`, hora: `${o.hour === "24" ? "00" : o.hour}:${o.minute}` };
}
function tzOffsetMs(tz: string, d: Date) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const o: Record<string, string> = {}; for (const p of f.formatToParts(d)) o[p.type] = p.value;
  const asUTC = Date.UTC(+o.year, +o.month - 1, +o.day, +o.hour, +o.minute, +o.second);
  return asUTC - d.getTime();
}
function toDate(p?: Prop): { date: Date; allDay: boolean } | null {
  if (!p) return null;
  const v = p.value;
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (!h) return { date: new Date(Date.UTC(+y, +mo - 1, +d, 12)), allDay: true };
  const naive = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  if (z) return { date: new Date(naive), allDay: false };
  const tz = p.params.TZID || TZ;
  let t = naive - tzOffsetMs(tz, new Date(naive));
  t = naive - tzOffsetMs(tz, new Date(t));
  return { date: new Date(t), allDay: false };
}
async function sha(s: string) {
  const b = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("").slice(0, 20);
}

Deno.serve(async (req) => {
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  let solo: string | null = null;
  try { solo = (await req.json())?.empleado || null; } catch { /* sin cuerpo */ }

  let q = sb.from("calendarios_google").select("empleado_id, ical_url");
  if (solo) q = q.eq("empleado_id", solo);
  const { data: cals, error } = await q;
  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });

  const { data: clis } = await sb.from("clientes").select("id, data");
  const desde = Date.now() - DIAS_ATRAS * 864e5, hasta = Date.now() + DIAS_ADELANTE * 864e5;
  const resumen: Record<string, unknown> = {};

  for (const c of cals || []) {
    try {
      const r = await fetch(c.ical_url, { headers: { "User-Agent": "ARK-Studio-Sync" } });
      if (!r.ok) throw new Error(`Google respondió ${r.status}`);
      const ics = await r.text();
      if (!ics.includes("BEGIN:VCALENDAR")) throw new Error("La dirección no es un calendario iCal");

      const rows: { id: string; data: Record<string, unknown> }[] = [];
      for (const ev of parseEvents(ics)) {
        if (ev.RRULE) continue;                                   // eventos repetitivos: se omiten
        if ((ev.STATUS?.[0]?.value || "").toUpperCase() === "CANCELLED") continue;
        const ini = toDate(ev.DTSTART?.[0]); if (!ini) continue;
        const t = ini.date.getTime(); if (t < desde || t > hasta) continue;
        const fin = toDate(ev.DTEND?.[0]);
        const uid = ev.UID?.[0]?.value || `${ev.DTSTART?.[0]?.value}-${ev.SUMMARY?.[0]?.value}`;
        const rid = ev["RECURRENCE-ID"]?.[0]?.value || "";
        const { fecha, hora } = partsInTZ(ini.date);
        const duracion = fin && !ini.allDay ? Math.max(5, Math.round((fin.date.getTime() - t) / 60000)) : 0;
        const titulo = unesc(ev.SUMMARY?.[0]?.value || "Cita de Google Calendar");
        const desc = unesc(ev.DESCRIPTION?.[0]?.value || "");
        const meet = (desc.match(/https:\/\/meet\.google\.com\/[a-z\-]+/) || [])[0] || "";
        const correos = (ev.ATTENDEE || []).map((a) => a.value.replace(/^mailto:/i, "").toLowerCase());
        const cli = (clis || []).find((x) => {
          const e = String(x.data?.email || "").toLowerCase();
          return e && correos.includes(e);
        });
        rows.push({
          id: "gcal-" + (await sha(c.empleado_id + "|" + uid + "|" + rid)),
          data: {
            titulo, fecha, hora: ini.allDay ? "" : hora, duracion,
            tipo: "Llamada", modalidad: "Virtual", empleadoId: c.empleado_id,
            clienteId: cli?.id || "",
            notas: ["Agendada en Google Calendar (se actualiza sola).", meet ? `Meet: ${meet}` : "", correos.length ? `Invitados: ${correos.join(", ")}` : ""].filter(Boolean).join("\n"),
            origen: "google", meet, creado: Date.now(),
          },
        });
      }

      if (rows.length) {
        const { error: e1 } = await sb.from("eventos").upsert(rows, { onConflict: "id" });
        if (e1) throw new Error(e1.message);
      }
      // Quitar citas de Google que ya no existen (dentro de la ventana sincronizada)
      const { data: prev } = await sb.from("eventos").select("id, data").eq("empleado_id", c.empleado_id).like("id", "gcal-%");
      const vivos = new Set(rows.map((r) => r.id));
      const desdeIso = partsInTZ(new Date(desde)).fecha;
      const borrar = (prev || []).filter((p) => !vivos.has(p.id) && String(p.data?.fecha || "") >= desdeIso).map((p) => p.id);
      if (borrar.length) await sb.from("eventos").delete().in("id", borrar);

      await sb.from("calendarios_google").update({ ultima_sync: new Date().toISOString(), ultimo_error: null }).eq("empleado_id", c.empleado_id);
      resumen[c.empleado_id] = { citas: rows.length, quitadas: borrar.length };
    } catch (e) {
      const msg = String((e as Error).message || e).slice(0, 300);
      await sb.from("calendarios_google").update({ ultimo_error: msg }).eq("empleado_id", c.empleado_id);
      resumen[c.empleado_id] = { error: msg };
    }
  }
  return new Response(JSON.stringify(resumen), { headers: { "Content-Type": "application/json" } });
});
