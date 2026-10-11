/* Motor de precios de ARK (cotizador).
   Calcula la cotización con reglas fijas a partir del tarifario (tabla `tarifarios`, editable por el admin y versionado).
   Es determinista: el mismo tarifario con la misma selección da siempre el mismo resultado. Claude NO calcula precios:
   solo redacta la propuesta, el guion y la presentación con lo que sale de aquí.
   ESTE ARCHIVO DEBE SER IDÉNTICO en web/cotizador.js (panel de la app) y supabase/functions/cotizacion/cotizador.js
   (servidor). Si cambias uno, copia el otro.
   Expone globalThis.ArkCotizador = {calcular, desdeEncuesta, completar, faltantes, dependientes, catalogo, ...}. */
(function (raiz) {
  'use strict';
  const NIVELES = ['basico', 'intermedio', 'avanzado', 'empresarial'];
  const PERMISOS = ['vendedor', 'supervisor', 'direccion', 'extraordinaria'];
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  const redondear = (n, paso) => { const p = num(paso) || 1; return Math.round(num(n) / p) * p; };
  const lista = (v) => (Array.isArray(v) ? v : []);
  const partir = (s) => String(s || '').split(/,\s+/).map((x) => x.trim()).filter(Boolean);
  const buscar = (arr, id) => lista(arr).find((x) => x && x.id === id) || null;
  const mayorPermiso = (a, b) => (PERMISOS.indexOf(b) > PERMISOS.indexOf(a) ? b : a);
  const slug = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'item';
  // Huella corta y estable (djb2) para comparar alcances sin depender de crypto.
  function huella(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h.toString(16).padStart(8, '0'); }

  const GRUPOS = [['transversal', 'transversales', 'Funciones generales'], ['integracion', 'integraciones', 'Integraciones externas'],
    ['automatizacion', 'automatizaciones', 'Automatizaciones'], ['especial', 'especiales', 'Fuera del catálogo']];

  // Todos los conceptos del tarifario por id, con su grupo y su industria.
  const cache = new WeakMap();
  function catalogo(t) {
    if (t && typeof t === 'object' && cache.has(t)) return cache.get(t);
    const m = {};
    for (const ind of lista(t && t.industrias)) for (const it of lista(ind.modulos)) m[it.id] = { ...it, grupo: 'modulo', industria: ind.id, industriaNombre: ind.nombre };
    for (const [grupo, llave, titulo] of GRUPOS) for (const it of lista(t && t[llave])) m[it.id] = { ...it, grupo, grupoNombre: titulo };
    if (t && typeof t === 'object') cache.set(t, m);
    return m;
  }
  const industriaDe = (t, id) => buscar(t.industrias, id) || lista(t.industrias)[0] || { id: '', nombre: '', base: 0, minimo: 0, modulos: [] };

  function normalizar(t, s) {
    s = s || {};
    const d = (arr, id) => (buscar(arr, id) ? id : (lista(arr)[0] || {}).id);
    const items = {};
    for (const [id, v] of Object.entries(s.items || {})) if (v) items[id] = { ...v };
    return {
      industria: industriaDe(t, s.industria).id,
      items,
      personalizados: lista(s.personalizados).filter((p) => p && String(p.nombre || '').trim())
        .map((p) => ({ id: String(p.id || slug(p.nombre)), nombre: String(p.nombre).trim(), monto: Math.max(0, num(p.monto)), confirmado: !!p.confirmado, nota: String(p.nota || '') })),
      ajustes_admin: s.ajustes_admin && typeof s.ajustes_admin === 'object' ? s.ajustes_admin : {},
      diseno: d(t.diseno, s.diseno), plataforma: d(t.plataformas, s.plataforma),
      sucursales: d(t.sucursales, s.sucursales), usuarios: d(t.usuarios, s.usuarios),
      carga: !!s.carga, plazo: d(t.plazos, s.plazo),
      mantenimiento: buscar(t.mantenimiento, s.mantenimiento) ? s.mantenimiento : '',
      descuento: { pct: Math.min(100, Math.max(0, num(s.descuento && s.descuento.pct))), motivo: String((s.descuento && s.descuento.motivo) || '') },
      hipotesis: lista(s.hipotesis).map(String),
    };
  }

  // Requisito cubierto: ya está seleccionado o lo incluye otro concepto seleccionado.
  function cubierto(cat, items, id) {
    if (items[id]) return true;
    return Object.keys(items).some((k) => lista(cat[k] && cat[k].incluye).includes(id));
  }

  // Agrega lo que falta: dependencias (requiere) y el panel administrativo cuando algún módulo lo necesita.
  // Modifica `items` y regresa los avisos de lo que agregó.
  function completar(t, items, industria) {
    const cat = catalogo(t), notas = [], ind = industriaDe(t, industria);
    const poner = (id, porque) => {
      const it = cat[id];
      if (!it || cubierto(cat, items, id)) return false;
      items[id] = { nivel: it.niveles ? 'intermedio' : null, origen: 'auto', motivo: `Lo necesita ${porque}` };
      notas.push(`Se agregó ${it.nombre} porque lo necesita ${porque}.`);
      return true;
    };
    let cambio = true, vueltas = 0;
    while (cambio && vueltas++ < 20) {
      cambio = false;
      for (const id of Object.keys(items)) {
        const it = cat[id];
        if (!it) continue;
        const nombre = items[id].nombre || it.nombre;
        for (const r of lista(it.requiere)) if (poner(r, nombre)) cambio = true;
        if (it.admin) {
          const destino = it.admin === true ? ind.admin : it.admin;
          const d = cat[destino];
          // si ya hay un panel equivalente (mismo "comparte"), no se agrega otro
          const yaHay = d && d.comparte && Object.keys(items).some((k) => cat[k] && cat[k].comparte === d.comparte);
          if (d && !yaHay && poner(destino, nombre)) cambio = true;
        }
      }
    }
    return notas;
  }

  // Lo que habría que agregar junto con `id` (sus dependencias y el panel), sin modificar `items`.
  function faltantes(t, items, id, industria) {
    const prueba = JSON.parse(JSON.stringify(items || {}));
    if (!prueba[id]) prueba[id] = { origen: 'panel' };
    completar(t, prueba, industria);
    return Object.keys(prueba).filter((k) => k !== id && !(items || {})[k]);
  }

  // Conceptos seleccionados que dependen de `id` (directa o indirectamente).
  function dependientes(t, items, id) {
    const cat = catalogo(t), fuera = new Set([id]);
    let cambio = true;
    while (cambio) {
      cambio = false;
      for (const k of Object.keys(items || {})) {
        if (fuera.has(k) || !cat[k]) continue;
        const req = lista(cat[k].requiere).filter((r) => fuera.has(r));
        // sigue cubierto si otro concepto que se queda lo incluye
        if (req.length && req.some((r) => !Object.keys(items).some((o) => !fuera.has(o) && o !== k && lista(cat[o] && cat[o].incluye).includes(r)))) { fuera.add(k); cambio = true; }
      }
    }
    fuera.delete(id);
    return [...fuera];
  }

  // ---------------- cálculo ----------------
  function calcular(t, seleccion, opciones) {
    const op = opciones || {};
    const sel = normalizar(t, seleccion);
    const cat = catalogo(t), pol = t.politica || {}, ind = industriaDe(t, sel.industria), R = t.redondeo;
    const avisos = [...sel.hipotesis];
    const L = [];
    const add = (x) => { const l = { monto: 0, desde: false, revision: false, provisional: false, nota: '', ...x }; L.push(l); return l; };
    add({ grupo: 'base', id: 'base.' + ind.id, nombre: 'Base: app web responsiva', detalle: t.base_incluye || '', monto: num(ind.base) });

    // conceptos del catálogo, con su nivel
    const ids = Object.keys(sel.items).filter((id) => {
      if (cat[id]) return true;
      avisos.push(`"${id}" ya no existe en el tarifario y no se cobró.`);
      return false;
    });
    const linea = {};
    for (const id of ids) {
      const it = cat[id], s = sel.items[id] || {};
      const nivel = it.niveles ? (NIVELES.includes(s.nivel) ? s.nivel : 'intermedio') : null;
      const nv = nivel ? ((t.niveles || {})[nivel] || {}) : {};
      const factor = nivel ? (num(nv.factor) || 1) : 1;
      let monto = redondear(num(it.precio) * factor, R), desde = !!(it.desde || nv.desde), revision = !!(it.revision || nv.revision);
      let provisional = !!(it.niveles && s.provisional), ajustado = false, nota = it.nota || '';
      const aj = sel.ajustes_admin[id];
      if (aj && aj.monto !== undefined && aj.monto !== null && aj.monto !== '') { monto = redondear(aj.monto, R); ajustado = true; }
      if (aj && aj.confirmado) { desde = false; revision = false; provisional = false; }
      if (aj && aj.nota) nota = String(aj.nota);
      if (provisional) nota = (nota ? nota + ' ' : '') + 'Nivel por definir con el cliente (precio provisional).';
      linea[id] = add({
        grupo: it.grupo, id, nombre: s.nombre || it.nombre, catalogoNombre: it.nombre, industria: it.industria || '',
        nivel, factor, precio: num(it.precio), hasta: it.hasta || null, monto, desde, revision, provisional, ajustado,
        origen: s.origen || 'panel', motivo: s.motivo || '', nota, comparte: it.comparte || '',
      });
    }
    // un mismo desarrollo no se cobra dos veces: lo incluido en otro concepto va en $0…
    for (const id of ids) for (const j of lista(cat[id].incluye)) {
      const l = linea[j];
      if (l && j !== id && !l.ajustado && !linea[id].incluido) Object.assign(l, { monto: 0, incluido: id, desde: false, revision: false, provisional: false, nota: `Incluido en ${linea[id].nombre}.` });
    }
    // …y los conceptos que comparten componente (pagos, notificaciones, panel, sucursales…) se cobran una sola vez: el mayor.
    const porClave = {};
    for (const id of ids) { const l = linea[id]; if (l.comparte && !l.incluido) (porClave[l.comparte] = porClave[l.comparte] || []).push(l); }
    for (const g of Object.values(porClave)) {
      if (g.length < 2) continue;
      const top = g.reduce((a, b) => (b.monto > a.monto || (b.monto === a.monto && b.ajustado && !a.ajustado) ? b : a));
      for (const l of g) if (l !== top) Object.assign(l, { monto: 0, compartido: top.id, desde: false, provisional: false, nota: `Se comparte con ${top.nombre}.` });
    }

    // sucursales: solo si no se cobró ya un módulo de sucursales
    const multi = ids.some((id) => cat[id].comparte === 'multisucursal');
    const suc = buscar(t.sucursales, sel.sucursales);
    if (suc && num(suc.precio) + (suc.revision ? 1 : 0) > 0) {
      if (multi) add({ grupo: 'sucursales', id: 'suc.' + suc.id, nombre: `Gestión de ${suc.nombre}`, monto: 0, nota: 'Ya se cobra en el módulo de sucursales.' });
      else add({ grupo: 'sucursales', id: 'suc.' + suc.id, nombre: `Gestión de ${suc.nombre}`, monto: num(suc.precio), desde: !!suc.desde, revision: !!suc.revision,
        nota: suc.revision ? 'Requiere revisión técnica.' : 'Gestión independiente o sincronizada de sucursales.' });
    }
    // usuarios: no se cobra por número de usuarios sin carga real
    const us = buscar(t.usuarios, sel.usuarios);
    if (us && us.revision) add({ grupo: 'usuarios', id: 'usu.' + us.id, nombre: `Capacidad para ${us.nombre.toLowerCase()}`, monto: 0, revision: true, nota: 'Requiere revisión técnica de capacidad.' });
    else if (us && num(us.precio) > 0) {
      if (sel.carga) add({ grupo: 'usuarios', id: 'usu.' + us.id, nombre: 'Pruebas de carga y optimización', monto: num(us.precio), desde: !!us.desde, nota: us.nota || '' });
      else avisos.push(`Usuarios: ${us.nombre}. No se cobra extra salvo que se justifiquen pruebas u optimizaciones adicionales ("Pruebas de carga").`);
    }
    const di = buscar(t.diseno, sel.diseno) || lista(t.diseno)[0];
    if (di) add({ grupo: 'diseno', id: 'dis.' + di.id, nombre: di.nombre, monto: num(di.precio), desde: !!di.desde, nota: di.nota || '' });
    const pl = buscar(t.plataformas, sel.plataforma) || lista(t.plataformas)[0];
    if (pl) add({ grupo: 'plataforma', id: 'plat.' + pl.id, nombre: pl.nombre, monto: num(pl.precio), desde: !!pl.desde, nota: pl.nativa ? 'Necesidades nativas especiales se cotizan aparte.' : '' });
    for (const p of sel.personalizados) add({
      grupo: 'personalizado', id: 'per.' + p.id, nombre: p.nombre, monto: redondear(p.monto, R), revision: !p.confirmado,
      nota: p.nota || (p.confirmado ? '' : 'Fuera del catálogo: requiere revisión y cotización personalizada.'),
    });

    // plazo: recargo sobre el subtotal técnico (antes del margen comercial)
    const tecnico = L.reduce((a, l) => a + l.monto, 0);
    const pz = buscar(t.plazos, sel.plazo);
    if (pz && num(pz.pct) > 0) add({ grupo: 'plazo', id: 'plazo.' + pz.id, nombre: `Entrega ${String(pz.nombre).toLowerCase()} (+${num(pz.pct)}%)`, monto: redondear(tecnico * num(pz.pct) / 100, R), nota: pz.nota || '' });
    const suma = L.reduce((a, l) => a + l.monto, 0);

    // precio de referencia, oferta y piso
    const minimo = num(ind.minimo);
    const pr = Math.max(minimo, suma);
    const oferta = redondear(pr * (num(pol.factor_oferta) || 1), R);
    const pisoProvisional = redondear(pr * (num(pol.factor_piso) || 1), R);
    const cd = num(op.cd);
    const margenMeta = pol.margen === undefined ? 0.6 : num(pol.margen);
    const pisoTecnico = cd > 0 && margenMeta < 1 ? redondear(cd / (1 - margenMeta), R) : (num(op.pisoTecnico) > 0 ? redondear(op.pisoTecnico, R) : 0);
    const piso = Math.max(pisoProvisional, minimo, pisoTecnico);
    const definitivo = pisoTecnico > 0;
    if (piso > oferta) avisos.push('El piso queda por encima de la oferta: revisa el costo directo, el alcance o las tarifas.');

    // descuento sobre la oferta y quién debe autorizarlo
    const pct = sel.descuento.pct;
    const negociado = redondear(oferta * (1 - pct / 100), R);
    let requiere = null;
    if (pct > 0) {
      requiere = 'vendedor';
      if (pct > num(pol.desc_vendedor)) requiere = mayorPermiso(requiere, 'supervisor');
      if (!definitivo && negociado < pr) requiere = mayorPermiso(requiere, 'supervisor'); // sin costo validado no se baja solo hacia el piso
      if (pct > num(pol.desc_supervisor)) requiere = mayorPermiso(requiere, 'direccion');
      if (negociado < piso) requiere = 'extraordinaria';
    }

    const estatus = L.some((l) => l.revision) ? 'revision' : L.some((l) => (l.desde && l.monto > 0) || l.provisional) ? 'desde' : 'validado';
    const planes = lista(t.mantenimiento);
    const mt = buscar(planes, sel.mantenimiento) || planes.find((p) => p.hasta && pr <= num(p.hasta)) || planes[planes.length - 1] || null;
    const claves = new Set(ids.map((id) => cat[id].comparte).filter(Boolean));
    const externos = lista(t.externos).filter((e) => lista(e.cuando).some((c) => c === '*' || (c === 'nativa' && pl && pl.nativa)
      || (c.startsWith('comparte:') && claves.has(c.slice(9))) || ids.includes(c))).map((e) => ({ id: e.id, nombre: e.nombre }));

    // versión para el cliente: sin precio de referencia, piso, costos ni autorizaciones.
    // Cada concepto se muestra proporcional a la oferta (la suma de las líneas da el precio inicial).
    const f = suma > 0 ? oferta / suma : 0;
    const lc = L.map((l) => ({
      grupo: l.grupo, nombre: l.nombre, nivel: l.nivel ? (((t.niveles || {})[l.nivel] || {}).nombre || l.nivel) : '',
      monto: redondear(l.monto * f, R), desde: !!(l.desde && l.monto > 0), revision: !!l.revision, incluido: l.monto === 0,
      nota: l.revision ? 'Sujeto a revisión técnica antes de confirmar el precio.' : l.provisional ? 'Alcance por confirmar.' : (l.incluido || l.compartido) ? 'Incluido.' : '',
    }));
    const dif = oferta - lc.reduce((a, l) => a + l.monto, 0);
    if (dif && lc.length) lc.reduce((a, b) => (b.monto > a.monto ? b : a)).monto += dif;

    const alcance = huella(JSON.stringify([ind.id, ids.slice().sort().map((id) => id + ':' + (linea[id].nivel || '')),
      sel.personalizados.map((p) => p.nombre).sort(), sel.diseno, sel.plataforma, sel.sucursales, sel.usuarios, sel.carga, sel.plazo]));

    return {
      industria: { id: ind.id, nombre: ind.nombre, estricto: !!ind.estricto },
      lineas: L, suma, minimo, ajuste_minimo: Math.max(0, minimo - suma), pr, oferta,
      piso_provisional: pisoProvisional, piso_tecnico: pisoTecnico || null, piso, piso_definitivo: definitivo,
      descuento: { pct, monto: oferta - negociado, motivo: sel.descuento.motivo, requiere },
      negociado, estatus,
      mantenimiento: mt ? { id: mt.id, nombre: mt.nombre, precio: num(mt.precio), desde: !!mt.desde } : null,
      externos, avisos,
      margen: cd > 0 && negociado > 0 ? (negociado - cd) / negociado : null, margen_meta: margenMeta,
      alcance,
      cliente: {
        lineas: lc, precio_inicial: oferta, descuento: oferta - negociado, total: negociado, estatus,
        mantenimiento: mt ? { nombre: mt.nombre, precio: num(mt.precio), desde: !!mt.desde, nota: t.mantenimiento_nota || '' } : null,
        externos, moneda: t.moneda || 'MXN',
      },
      seleccion: sel,
    };
  }

  // ---------------- encuesta → selección ----------------
  // `enc` es data.encuesta del cliente (textos de la encuesta y, desde oct 2026, el JSON `cotizacion`).
  function desdeEncuesta(t, enc) {
    enc = enc || {};
    let cot = enc.cotizacion;
    if (typeof cot === 'string') { try { cot = JSON.parse(cot); } catch (_) { cot = null; } }
    if (!cot || typeof cot !== 'object') cot = null;
    const E = t.encuesta || {}, cat = catalogo(t), hip = [];
    const giro = String((cot && cot.industria) || enc.giro || '').trim();
    let industria = (E.giros || {})[giro];
    if (!industria) {
      industria = buscar(t.industrias, E.sin_tarifario) ? E.sin_tarifario : (lista(t.industrias)[0] || {}).id;
      hip.push(giro ? `El giro "${giro}" no tiene tarifas propias: se cotizó como ${industriaDe(t, industria).nombre}. Revisa que aplique.`
        : `La encuesta no trae giro: se cotizó como ${industriaDe(t, industria).nombre}.`);
    }
    const mapas = E.sistemas || {}, mapa = mapas[giro] || mapas._general || {};
    const items = {}, personalizados = [], porDefinir = [];
    const poner = (id, nivel, provisional, nombre, fuente) => {
      const it = cat[id];
      if (!it) return false;
      const x = items[id];
      if (x) {
        if (it.niveles && NIVELES.indexOf(nivel) > NIVELES.indexOf(x.nivel)) { x.nivel = nivel; x.provisional = provisional; }
        if (fuente && !x.fuente.includes(fuente)) x.fuente.push(fuente);
        return true;
      }
      items[id] = { nivel: it.niveles ? nivel : null, provisional: !!(it.niveles && provisional), origen: 'encuesta', fuente: fuente ? [fuente] : [] };
      if (nombre) items[id].nombre = nombre;
      return true;
    };
    const sistemas = cot && Array.isArray(cot.sistemas)
      ? cot.sistemas.map((s) => ({ nombre: String(s.nombre || ''), nivel: s.nivel, codigos: lista(cot.modulos && cot.modulos[s.modulo] && cot.modulos[s.modulo].codigos) }))
      : partir(enc.sistemas).map((nombre) => ({ nombre, nivel: null, codigos: [] }));
    for (const s of sistemas) {
      const entradas = mapa[s.nombre];
      if (!entradas) {
        if (s.nombre) {
          personalizados.push({ id: slug(s.nombre), nombre: s.nombre, monto: 0, nota: 'Lo pidió en la encuesta; no está en el catálogo: requiere revisión y cotización personalizada.' });
          hip.push(`"${s.nombre}" no está en el catálogo: quedó para cotización personalizada.`);
        }
        continue;
      }
      const nivel = NIVELES.includes(s.nivel) ? s.nivel : 'intermedio';
      // sin respuesta de nivel (encuestas anteriores o "No estoy seguro"): Intermedio con precio provisional
      const provisional = !cot || s.nivel === 'por_definir' || s.nivel === 'no_se';
      let conNiveles = false;
      for (const e of entradas) {
        const o = typeof e === 'string' ? { id: e } : e;
        if (o.solo && !o.solo.some((c) => s.codigos.includes(c))) continue;
        if (o.excepto && s.codigos.length && s.codigos.every((c) => o.excepto.includes(c))) continue;
        if (poner(o.id, nivel, provisional, o.nombre, s.nombre) && cat[o.id].niveles) conNiveles = true;
      }
      if (provisional && conNiveles) porDefinir.push(s.nombre);
    }
    if (porDefinir.length) hip.push(`Nivel por definir en: ${porDefinir.join(', ')}. Se cotizó como Intermedio con precio provisional; confírmalo con el cliente.`);

    const integ = cot && cot.integraciones ? lista(cot.integraciones.categorias) : partir(enc.integraciones);
    const cual = String((cot && cot.integraciones && cot.integraciones.plataformas) || enc.integraciones_cual || '').trim();
    let reales = 0;
    for (const x of integ) {
      if (x === 'No estoy seguro') { hip.push('No sabe si usa sistemas que haya que conectar: pregúntalo en la llamada.'); continue; }
      const id = (E.integraciones || {})[x];
      if (!id) continue;
      reales++;
      poner(id, 'intermedio', false, id === 'esp.integracion_otra' && cual ? `Integración con ${cual}` : undefined, x);
    }
    if (reales) hip.push(`Integraciones con sistemas que ya usa${cual ? ` (${cual})` : ''}: verifica proveedor, API, costos y viabilidad antes de confirmar.`);
    for (const n of completar(t, items, industria)) hip.push(n);

    const val = (k, texto) => { const v = ((E[k] || {})[texto]); return v === undefined ? null : v; };
    const tDis = String((cot && cot.diseno && cot.diseno.texto) || enc.diseno || '').trim();
    let diseno = val('diseno', tDis);
    if (!diseno) { diseno = 'esencial'; hip.push('No eligió estilo de diseño: se tomó Esencial.'); }
    const tPlat = String((cot && cot.plataforma) || enc.plataforma || '').trim();
    let plataforma = val('plataforma', tPlat);
    if (!plataforma) { plataforma = 'web'; hip.push('No dijo en qué plataforma la quiere: se cotizó web responsiva.'); }
    else if (tPlat === 'Aún no sé') hip.push('Aún no sabe la plataforma: se cotizó web responsiva; si la quiere en las tiendas de apps, cámbiala.');
    const tSuc = String((cot && cot.sucursales) || enc.sucursales || '').trim();
    let sucursales = val('sucursales', tSuc);
    if (!sucursales) { sucursales = '1'; hip.push('No dijo cuántas sucursales tiene: se tomó 1.'); }
    const tUs = String((cot && cot.usuarios_mes) || enc.usuarios_mes || '').trim();
    const usuarios = val('usuarios', tUs) || 'no_se';
    const tiempo = String((cot && cot.tiempo) || enc.tiempo || '');
    if (/menos de un mes/i.test(tiempo)) hip.push('Lo quiere en menos de un mes. No se aplicó recargo: si la entrega urgente implica trabajo adicional y es viable, elige "Urgente" en el plazo.');
    return {
      industria, items, personalizados, ajustes_admin: {}, diseno, plataforma, sucursales, usuarios, carga: false,
      plazo: 'normal', mantenimiento: '', descuento: { pct: 0, motivo: '' }, hipotesis: hip,
    };
  }

  const ETIQUETAS = {
    estatus: { validado: 'Precio validado', desde: 'Estimado "desde"', revision: 'Requiere revisión' },
    permiso: { vendedor: 'Vendedor', supervisor: 'Supervisor', direccion: 'Dirección', extraordinaria: 'Autorización extraordinaria' },
  };

  const api = { version: 1, NIVELES, PERMISOS, ETIQUETAS, GRUPOS, catalogo, industriaDe, normalizar, calcular, desdeEncuesta, completar, faltantes, dependientes, huella, redondear, mayorPermiso };
  raiz.ArkCotizador = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
