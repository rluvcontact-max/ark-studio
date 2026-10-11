// Cotizaciones de ARK: guarda versiones inmutables calculadas con el motor de precios (cotizador.js, idéntico a web/cotizador.js).
// El navegador nunca escribe precios: manda la selección (funciones, niveles, diseño, plataforma, descuento…) y aquí se recalcula.
//
// POST {accion:"inicial", clienteId}   → si el cliente no tiene cotización, crea la v1 a partir de la encuesta. Regresa la última.
//   Admin, vendedor del cliente o interno (propuesta-claude, header x-ark-interno).
// POST {accion:"guardar", clienteId, seleccion, base, tarifa, nota, cd}
//   → nueva versión. Vendedor: no puede tocar precios del catálogo ni de lo personalizado; descuento hasta su límite
//     (más arriba queda "pendiente de autorización"). Admin: todo; `cd` = costo directo validado (piso técnico y margen).
// POST {accion:"autorizar", clienteId, version}  → (admin) autoriza el descuento de una versión pendiente: crea otra versión.
// POST {accion:"confirmar", clienteId, version}  → usa esa versión en la presentación y el guion. Si el alcance es el mismo
//   que el de los materiales, se actualiza al instante; si cambió, Claude los vuelve a generar (propuesta-claude).
// Desplegada con verify_jwt = true.
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import "./cotizador.js";

// deno-lint-ignore no-explicit-any
const C = (globalThis as any).ArkCotizador;
const URL_SB = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const ORIGENES = ["https://arkdashboardmx.netlify.app"];
type O = Record<string, unknown>;

function cors(origin: string | null) {
  const ok = origin && (ORIGENES.includes(origin) || /^https:\/\/[a-z0-9]+--arkdashboardmx\.netlify\.app$/.test(origin));
  return {
    "Access-Control-Allow-Origin": ok ? origin! : ORIGENES[0],
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Vary": "Origin",
  };
}
async function firmaInterna() {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("ark-interno:" + SERVICE));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
class Aviso extends Error { constructor(m: string, public status = 400) { super(m); } }

type Quien = { uid: string | null; nombre: string; admin: boolean; empleado: string | null; interno: boolean };

async function tarifario(sb: SupabaseClient, version?: number) {
  let q = sb.from("tarifarios").select("version,data");
  q = version ? q.eq("version", version) : q.order("version", { ascending: false }).limit(1);
  const { data, error } = await q;
  if (error) throw error;
  if (data && data.length) return { version: data[0].version as number, t: data[0].data as O };
  throw new Aviso(version ? "No existe esa versión del tarifario" : "Aún no hay tarifario (tabla tarifarios).", 500);
}

async function cliente(sb: SupabaseClient, id: string) {
  const { data } = await sb.from("clientes").select("id,data").eq("id", id).maybeSingle();
  if (!data) throw new Aviso("No encontramos este cliente", 404);
  return data.data as O;
}
function puedeVer(q: Quien, c: O) {
  return q.interno || q.admin || (!!q.empleado && c.empleadoId === q.empleado);
}
async function versiones(sb: SupabaseClient, clienteId: string) {
  const { data, error } = await sb.from("cotizaciones").select("version,data").eq("cliente_id", clienteId).order("version", { ascending: false });
  if (error) throw error;
  return (data ?? []).map((r) => r.data as O);
}
async function costoPara(sb: SupabaseClient, clienteId: string, alcance: string) {
  const { data } = await sb.from("cotizacion_costos").select("data,creado").eq("cliente_id", clienteId).order("creado", { ascending: false });
  const fila = (data ?? []).find((r) => (r.data as O).alcance === alcance);
  return fila ? Number((fila.data as O).cd) || 0 : 0;
}

// Calcula y guarda una versión nueva. Lo que lee el equipo no lleva costo directo ni margen (eso va en cotizacion_costos).
async function insertar(sb: SupabaseClient, q: Quien, clienteId: string, tv: { version: number; t: O }, seleccion: O, extra: O, cdNuevo = 0) {
  const previas = await versiones(sb, clienteId);
  const anterior = previas[0] ?? null;
  let r = C.calcular(tv.t, seleccion);
  const cd = cdNuevo > 0 ? cdNuevo : await costoPara(sb, clienteId, r.alcance);
  if (cd > 0) r = C.calcular(tv.t, seleccion, { cd });
  const version = (Number(anterior?.version) || 0) + 1;
  const { margen, piso_tecnico, seleccion: sel, cliente: paraCliente, ...resultado } = r;
  void piso_tecnico;
  const data: O = {
    version, clienteId, tarifa_version: tv.version, creado: Date.now(),
    autor: { uid: q.uid, nombre: q.nombre, rol: q.admin ? "admin" : q.interno ? "sistema" : "vendedor" },
    seleccion: sel, resultado, cliente: paraCliente, alcance: r.alcance,
    anterior: anterior ? { version: anterior.version, oferta: (anterior.resultado as O)?.oferta, negociado: (anterior.resultado as O)?.negociado } : null,
    estado: "guardada", nota: "", ...extra,
  };
  const { error } = await sb.from("cotizaciones").insert({ id: `${clienteId}:${version}`, cliente_id: clienteId, version, data, autor: q.uid });
  if (error) throw error;
  if (cdNuevo > 0) {
    await sb.from("cotizacion_costos").upsert({ id: `${clienteId}:${version}`, cliente_id: clienteId,
      data: { cd: cdNuevo, alcance: r.alcance, margen, por: q.uid, nombre: q.nombre, fecha: Date.now() } });
  }
  return { ...data, ...(q.admin ? { costo: cd > 0 ? { cd, margen } : null } : {}) };
}

async function inicial(sb: SupabaseClient, q: Quien, clienteId: string) {
  const c = await cliente(sb, clienteId);
  if (!puedeVer(q, c)) throw new Aviso("No tienes acceso a este cliente", 403);
  const previas = await versiones(sb, clienteId);
  if (previas.length) return previas[0];
  const tv = await tarifario(sb);
  const enc = (c.encuesta ?? {}) as O;
  const seleccion = Object.keys(enc).length ? C.desdeEncuesta(tv.t, enc)
    : { industria: "", items: {}, hipotesis: ["Este cliente no llegó por la encuesta: agrega en el panel las funciones que necesita."] };
  return await insertar(sb, q, clienteId, tv, seleccion, { origen: Object.keys(enc).length ? "encuesta" : "manual", nota: "Cotización inicial calculada a partir de la encuesta." });
}

async function guardar(sb: SupabaseClient, q: Quien, b: O) {
  const clienteId = String(b.clienteId || "");
  const c = await cliente(sb, clienteId);
  if (!puedeVer(q, c)) throw new Aviso("No tienes acceso a este cliente", 403);
  const previas = await versiones(sb, clienteId);
  const base = previas.find((v) => v.version === Number(b.base)) ?? previas[0] ?? null;
  const tv = await tarifario(sb, Number(b.tarifa) || (base?.tarifa_version as number) || undefined);
  const sel = C.normalizar(tv.t, b.seleccion ?? {});
  const selBase = (base?.seleccion ?? {}) as O;
  if (!q.admin) {
    // el vendedor no sobrescribe precios del catálogo ni de lo personalizado: se conservan los que puso el admin
    sel.ajustes_admin = selBase.ajustes_admin ?? {};
    const previos = new Map(((selBase.personalizados ?? []) as O[]).map((p) => [String(p.id), p]));
    sel.personalizados = sel.personalizados.map((p: O) => {
      const x = previos.get(String(p.id));
      return { ...p, monto: x ? Number(x.monto) || 0 : 0, confirmado: x ? !!x.confirmado : false };
    });
    // proyecto firmado: no se quita alcance ya contratado (va como gestión de cambios con el admin)
    if (c.estado === "cerrado" && base) {
      const quitados = Object.keys((selBase.items ?? {}) as O).filter((id) => !sel.items[id]);
      if (quitados.length) throw new Aviso("El proyecto ya está firmado: para quitar funciones pide al administrador una gestión de cambios.");
    }
  }
  const prueba = C.calcular(tv.t, sel, { pisoTecnico: 0 });
  const d = prueba.descuento as O;
  if (Number(d.pct) > 0 && !String(sel.descuento.motivo || "").trim()) throw new Aviso("Escribe el motivo del descuento.");
  const cdNuevo = q.admin ? Math.max(0, Number(b.cd) || 0) : 0;
  // con el costo validado el piso puede cambiar: se recalcula con él para decidir la autorización
  const cd = cdNuevo || await costoPara(sb, clienteId, prueba.alcance);
  const r = cd ? C.calcular(tv.t, sel, { cd }) : prueba;
  const requiere = r.descuento.requiere as string | null;
  let estado = "guardada", autorizado: O | null = null;
  if (requiere && requiere !== "vendedor") {
    if (q.admin) {
      if (requiere === "extraordinaria" && !b.extraordinaria) throw new Aviso("Ese precio queda debajo del piso: confirma la autorización extraordinaria.");
      autorizado = { por: q.uid, nombre: q.nombre, fecha: Date.now(), nivel: requiere };
    } else estado = "pendiente";
  } else if (requiere === "vendedor") autorizado = { por: q.uid, nombre: q.nombre, fecha: Date.now(), nivel: "vendedor" };
  return await insertar(sb, q, clienteId, tv, sel, {
    origen: "panel", estado, nota: String(b.nota || "").slice(0, 500),
    autorizacion: autorizado, solicita: estado === "pendiente" ? { nivel: requiere, por: q.uid, nombre: q.nombre, fecha: Date.now() } : null,
  }, cdNuevo);
}

async function autorizar(sb: SupabaseClient, q: Quien, b: O) {
  if (!q.admin) throw new Aviso("Solo el administrador autoriza descuentos", 403);
  const clienteId = String(b.clienteId || "");
  const previas = await versiones(sb, clienteId);
  const v = previas.find((x) => x.version === Number(b.version));
  if (!v) throw new Aviso("No encontramos esa versión", 404);
  if (v.estado !== "pendiente") throw new Aviso("Esa versión no está pendiente de autorización");
  const tv = await tarifario(sb, v.tarifa_version as number);
  const r = C.calcular(tv.t, v.seleccion);
  if (r.descuento.requiere === "extraordinaria" && !b.extraordinaria) throw new Aviso("Ese precio queda debajo del piso: confirma la autorización extraordinaria.");
  return await insertar(sb, q, clienteId, tv, v.seleccion as O, {
    origen: "autorizacion", estado: "guardada", nota: `Descuento autorizado (versión ${v.version}).`,
    autorizacion: { por: q.uid, nombre: q.nombre, fecha: Date.now(), nivel: r.descuento.requiere, version: v.version },
    solicita: v.solicita ?? null,
  });
}

// Lo que se guarda en propuestas: la misma versión para cotización, guion y presentación.
function paraPropuesta(v: O) {
  const r = v.resultado as O;
  return {
    version: v.version, alcance: v.alcance, estatus: r.estatus,
    precios: { oferta: r.oferta, referencia: r.pr, piso: r.piso, piso_definitivo: r.piso_definitivo, negociado: r.negociado, descuento: (r.descuento as O)?.monto ?? 0 },
    mantenimiento: r.mantenimiento, cliente: v.cliente,
  };
}

async function confirmar(sb: SupabaseClient, q: Quien, b: O) {
  const clienteId = String(b.clienteId || "");
  const c = await cliente(sb, clienteId);
  if (!puedeVer(q, c)) throw new Aviso("No tienes acceso a este cliente", 403);
  const previas = await versiones(sb, clienteId);
  const v = previas.find((x) => x.version === Number(b.version));
  if (!v) throw new Aviso("No encontramos esa versión", 404);
  if (v.estado === "pendiente") throw new Aviso("Esta versión tiene un descuento pendiente de autorización.");
  const { data: prop } = await sb.from("propuestas").select("data").eq("id", clienteId).maybeSingle();
  const pd = (prop?.data ?? {}) as O;
  const snap = paraPropuesta(v);
  const r = v.resultado as O;
  // el valor estimado del cliente es el precio negociado (si aún no está cerrado)
  if (c.estado !== "cerrado" && Number(r.negociado) > 0) await sb.from("clientes").update({ data: { ...c, valor: r.negociado, actualizado: Date.now() } }).eq("id", clienteId);
  const mismaBase = pd.estado === "lista" && pd.datos && (pd.cotizacion as O | undefined)?.alcance === v.alcance;
  if (mismaBase) {
    const datos = { ...(pd.datos as O), pricing: preciosClaude((pd.datos as O).pricing as O, snap) };
    await sb.from("propuestas").update({ data: { ...pd, datos, cotizacion: snap } }).eq("id", clienteId);
    return { modo: "inmediato", version: v.version };
  }
  // cambió el alcance (o aún no hay materiales): Claude vuelve a escribir propuesta, guion y presentación con esta versión
  const res = await fetch(`${URL_SB}/functions/v1/propuesta-claude`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ANON}`, apikey: ANON, "x-ark-interno": await firmaInterna() },
    body: JSON.stringify({ id: clienteId, version: v.version }),
  });
  const j = await res.json().catch(() => ({})) as O;
  if (!res.ok) throw new Aviso(String(j.error || "No se pudo pedir a Claude la nueva presentación."), 502);
  return { modo: "claude", version: v.version };
}

// Los 3 precios que ya usa la app (oferta ≥ objetivo ≥ mínimo) salen de la cotización: oferta, referencia y piso.
function preciosClaude(pr: O | undefined, snap: ReturnType<typeof paraPropuesta>) {
  return {
    ...(pr ?? {}),
    offer_price_mxn: snap.precios.oferta, target_price_mxn: snap.precios.referencia, minimum_acceptable_price_mxn: snap.precios.piso,
    negotiated_price_mxn: snap.precios.negociado, monthly_maintenance_mxn: (snap.mantenimiento as O | null)?.precio ?? 0,
  };
}

Deno.serve(async (req) => {
  const h = cors(req.headers.get("origin"));
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...h, "Content-Type": "application/json" } });
  if (req.method === "OPTIONS") return new Response(null, { headers: h });
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);
  const b = await req.json().catch(() => ({})) as O;
  const sb = createClient(URL_SB, SERVICE);
  try {
    const interno = req.headers.get("x-ark-interno") === await firmaInterna();
    let q: Quien = { uid: null, nombre: "Sistema", admin: false, empleado: null, interno };
    if (!interno) {
      const u = createClient(URL_SB, ANON, { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
      const { data: { user } } = await u.auth.getUser();
      if (!user) return json({ error: "Inicia sesión" }, 401);
      const [{ data: admin }, { data: emp }] = await Promise.all([u.rpc("es_admin"), u.rpc("mi_empleado")]);
      let nombre = admin ? "Administrador" : "Vendedor";
      if (emp) {
        const { data: e } = await sb.from("empleados").select("data").eq("id", String(emp)).maybeSingle();
        nombre = String((e?.data as O | undefined)?.nombre ?? "") || nombre;
      } else if (admin) nombre = "Ricardo Lua";
      q = { uid: user.id, nombre, admin: !!admin, empleado: emp ? String(emp) : null, interno: false };
    }
    const accion = String(b.accion || "");
    if (accion === "inicial") return json(await inicial(sb, q, String(b.clienteId || "")));
    if (interno) return json({ error: "Acción no permitida" }, 403);
    if (accion === "guardar") return json(await guardar(sb, q, b));
    if (accion === "autorizar") return json(await autorizar(sb, q, b));
    if (accion === "confirmar") return json(await confirmar(sb, q, b));
    return json({ error: "Acción desconocida" }, 400);
  } catch (e) {
    if (e instanceof Aviso) return json({ error: e.message }, e.status);
    console.error(e);
    return json({ error: e instanceof Error ? e.message : "Error" }, 500);
  }
});
