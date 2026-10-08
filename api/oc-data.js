// Seguimiento OC — datos en vivo DIRECTO desde Odoo 18 (JSON-RPC), sin BigQuery ni almacenamiento.
// Variables de entorno (Vercel › Settings › Environment Variables):
//   ODOO_URL      ej. https://etcetera.xmarts.net   (con o sin /odoo al final)
//   ODOO_DB       nombre de la base de datos
//   ODOO_USER     usuario de integración (solo lectura en Compras, Inventario, Contabilidad y Contenedores)
//   ODOO_API_KEY  llave API de ese usuario
// GET /api/oc-data            → respuesta cacheable 2 min en Vercel (protege a Odoo si muchos abren a la vez)
// GET /api/oc-data?fresh=1    → consulta Odoo en ese momento (botón "Actualizar"), sin caché
// La respuesta conserva el mismo formato que la versión con BigQuery: _todos, containers, gastosDesglose, costeoExtra, snapshot.

const TZ = 'America/Mexico_City';

function baseUrl() {
  return String(process.env.ODOO_URL || '').trim().replace(/\/+$/, '').replace(/\/odoo$/, '');
}

let rpcId = 0;
async function rpc(service, method, args) {
  const r = await fetch(baseUrl() + '/jsonrpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'call', id: ++rpcId, params: { service, method, args } }),
  });
  if (!r.ok) throw new Error('Odoo respondió HTTP ' + r.status);
  const j = await r.json();
  if (j.error) {
    const d = j.error.data || {};
    throw new Error('Odoo: ' + (d.message || j.error.message || 'error desconocido'));
  }
  return j.result;
}

async function login() {
  const uid = await rpc('common', 'authenticate', [process.env.ODOO_DB, process.env.ODOO_USER, process.env.ODOO_API_KEY, {}]);
  if (!uid) throw new Error('Odoo rechazó el usuario o la llave API (revisa ODOO_DB, ODOO_USER y ODOO_API_KEY).');
  return uid;
}

function searchRead(uid, model, domain, fields, order) {
  const kw = { fields, context: { active_test: false } };   // sin 'lang': Odoo usa su idioma por defecto (es_MX no está instalado)
  if (order) kw.order = order;
  return rpc('object', 'execute_kw', [process.env.ODOO_DB, uid, process.env.ODOO_API_KEY, model, 'search_read', [domain], kw]);
}

// ---- utilidades de formato (equivalentes a las funciones usadas en las consultas de BigQuery) ----
const m2oId = (v) => (Array.isArray(v) ? v[0] : (v || null));
const m2oName = (v) => (Array.isArray(v) ? v[1] : null);
const str = (v) => (v === false || v === undefined ? null : v);
function dateLocal(v) {              // datetime de Odoo (UTC) → 'YYYY-MM-DD' en hora de México
  if (!v) return null;
  const d = new Date(String(v).replace(' ', 'T') + 'Z');
  if (isNaN(d)) return null;
  return d.toLocaleDateString('en-CA', { timeZone: TZ });
}
const dateOnly = (v) => (v ? String(v).slice(0, 10) : null);   // campos tipo date
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const initcap = (s) => String(s).toLowerCase().replace(/(^|[^a-záéíóúüñ0-9])([a-záéíóúüñ])/g, (m, a, b) => a + b.toUpperCase());
const splitOrigin = (s) => (s ? String(s).split(',').map((x) => x.trim()).filter(Boolean) : []);
const ESTADO_RANK = { or: 0, tr: 1, ad: 2, de: 3, ar: 4 };

async function construir() {
  const uid = await login();

  const [pos, lines, picks, bills, conts, arrCat] = await Promise.all([
    searchRead(uid, 'purchase.order', [], ['name', 'x_nombre_prov', 'date_order', 'state', 'receipt_status', 'amount_total',
      'currency_rate', 'date_planned', 'x_studio_fecha_de_produccin', 'x_nombre_arribo_oc', 'user_id'], 'date_order asc, id asc'),
    searchRead(uid, 'purchase.order.line', [['display_type', '=', false]], ['order_id', 'product_id', 'product_qty', 'qty_received', 'price_unit', 'price_subtotal']),
    searchRead(uid, 'stock.picking', [['container_id', '!=', false]], ['origin', 'container_id', 'state', 'date_done', 'x_studio_arribo']),
    searchRead(uid, 'account.move', [['move_type', '=', 'in_invoice'], ['state', '=', 'posted'], ['invoice_origin', '!=', false]],
      ['invoice_origin', 'payment_state', 'amount_residual']),
    searchRead(uid, 'containers.move', [], ['name', 'estado', 'transport_type', 'pickup_date', 'shipment_date', 'customs_date',
      'clearance_date', 'arrival_date', 'expected_date', 'landed_cost_id', 'shipment_by', 'customs']),
    searchRead(uid, 'x_nombre_arribo', [], ['display_name']).catch(() => []),   // catálogo de arribos (Air #5-26, …); opcional
  ]);
  const arribosCat = new Map((Array.isArray(arrCat) ? arrCat : []).map((a) => [a.id, String(a.display_name || '').trim()]));

  const costIds = [...new Set(conts.map((c) => m2oId(c.landed_cost_id)).filter(Boolean))];
  const lcl = costIds.length
    ? await searchRead(uid, 'stock.landed.cost.lines', [['cost_id', 'in', costIds]], ['cost_id', 'name', 'price_unit'], 'id asc')
    : [];

  // --- Llegada deducida por recepciones ---
  // Si todas las recepciones (no canceladas) de un contenedor están validadas y en Odoo no se marcó "Arribado",
  // se considera arribado con la fecha de la última recepción. Se marca estado_inferido para mostrarlo en el tracker.
  const picksPorCont = new Map();
  for (const sp of picks) {
    const cid = m2oId(sp.container_id); if (!cid || sp.state === 'cancel') continue;
    if (!picksPorCont.has(cid)) picksPorCont.set(cid, []);
    picksPorCont.get(cid).push(sp);
  }
  for (const cm of conts) {
    cm.estado_odoo = cm.estado;
    cm.estado_inferido = false;
    const ps = picksPorCont.get(cm.id) || [];
    if (cm.estado !== 'ar' && ps.length && ps.every((sp) => sp.state === 'done')) {
      const ult = ps.map((sp) => sp.date_done).filter(Boolean).sort().pop();
      cm.estado = 'ar';
      cm.estado_inferido = true;
      if (!cm.arrival_date && ult) cm.arrival_date = dateLocal(ult);
    }
  }

  // --- Arribos divididos: una OC puede venir en 2+ arribos ("Air #4-26, Air #5-26") ---
  const arribosDe = (p) => splitOrigin(p.x_nombre_arribo_oc);
  const divididas = pos.filter((p) => arribosDe(p).length > 1);
  const nombresArriboPick = (sp) => (Array.isArray(sp.x_studio_arribo) ? sp.x_studio_arribo : [])
    .map((id) => arribosCat.get(id)).filter(Boolean);
  let movesDiv = [];
  const picksDiv = [];
  if (divididas.length) {
    const nombresDiv = new Set(divididas.map((p) => p.name));
    for (const sp of picks) {
      if (sp.state === 'cancel') continue;
      if (splitOrigin(sp.origin).some((n) => nombresDiv.has(n))) picksDiv.push(sp);
    }
    if (picksDiv.length) {
      movesDiv = (await searchRead(uid, 'stock.move', [['picking_id', 'in', picksDiv.map((sp) => sp.id)], ['state', '!=', 'cancel']],
        ['picking_id', 'purchase_line_id', 'product_id', 'product_uom_qty', 'quantity', 'state']).catch(() => [])) || [];   // opcional: sin esto las OCs divididas no se reparten (se muestran como "—")
    }
  }

  // --- agregados por OC (equivalente a polq) ---
  const polq = new Map();
  for (const l of lines) {
    const oid = m2oId(l.order_id); if (!oid) continue;
    let a = polq.get(oid);
    if (!a) { a = { ped: 0, rec: 0, prods: new Set() }; polq.set(oid, a); }
    a.ped += Number(l.product_qty) || 0;
    a.rec += Number(l.qty_received) || 0;
    if (l.product_id) a.prods.add(m2oId(l.product_id));
  }
  // Reparto de cada OC dividida entre sus arribos, con las piezas de las recepciones etiquetadas con cada arribo.
  // El monto NO se estima: piezas de cada producto en ese arribo × su precio unitario en la OC (neto de descuento).
  const lineaOC = new Map(lines.map((l) => [l.id, m2oId(l.order_id)]));
  const precioLinea = new Map(lines.map((l) => {
    const q = Number(l.product_qty) || 0;
    const unit = q > 0 && l.price_subtotal != null ? Number(l.price_subtotal) / q : Number(l.price_unit) || 0;
    return [l.id, unit];
  }));
  const pickById = new Map(picksDiv.map((sp) => [sp.id, sp]));
  // po_id → Map(arribo → { peso, dem, rec, prods, valor }):
  //   valor = Σ demanda × precio unitario de la línea de OC (moneda de la OC) → monto exacto del arribo
  //   peso = piezas para repartir el monto (recibidas si la recepción está hecha, demanda si no)
  //   dem  = Demanda de las recepciones de ese arribo  → "Pz pedidas" del arribo
  //   rec  = Cantidad recibida (movimientos hechos)     → "Pz recibidas" del arribo
  //   prods = productos distintos que vienen en ese arribo → "SKUs" del arribo
  const piezasArribo = new Map();
  const demEtiquetadaLinea = new Map();   // línea de OC → demanda que ya está en recepciones etiquetadas con arribo
  for (const mv of movesDiv) {
    const oid = lineaOC.get(m2oId(mv.purchase_line_id)); if (!oid) continue;
    const sp = pickById.get(m2oId(mv.picking_id)); if (!sp) continue;
    const tags = nombresArriboPick(sp); if (!tags.length) continue;
    const dem = Number(mv.product_uom_qty) || 0;
    const rec = mv.state === 'done' ? (Number(mv.quantity) || 0) : 0;
    const peso = mv.state === 'done' ? rec : dem;
    const lid = m2oId(mv.purchase_line_id);
    demEtiquetadaLinea.set(lid, (demEtiquetadaLinea.get(lid) || 0) + dem);
    if (!piezasArribo.has(oid)) piezasArribo.set(oid, new Map());
    const m = piezasArribo.get(oid);
    for (const t of tags) {
      if (!m.has(t)) m.set(t, { peso: 0, dem: 0, rec: 0, prods: new Set(), valor: 0 });
      const a = m.get(t);
      a.peso += peso / tags.length; a.dem += dem / tags.length; a.rec += rec / tags.length;
      a.valor += (dem * (precioLinea.get(m2oId(mv.purchase_line_id)) || 0)) / tags.length;
      if (mv.product_id && (dem > 0 || rec > 0)) a.prods.add(m2oId(mv.product_id));
    }
  }
  // Porcentajes con 1 decimal que siempre suman 100.0 (método del mayor residuo)
  function pctsCien(valores) {
    const tot = valores.reduce((s, v) => s + v, 0);
    if (!tot) return valores.map(() => 0);
    const crudos = valores.map((v) => (v / tot) * 1000);          // décimas de punto
    const base = crudos.map(Math.floor);
    let falta = 1000 - base.reduce((s, v) => s + v, 0);
    crudos.map((v, i) => [v - base[i], i]).sort((a, b) => b[0] - a[0]).forEach(([, i]) => { if (falta > 0) { base[i]++; falta--; } });
    return base.map((v) => v / 10);
  }
  const lineasDeOC = new Map();
  for (const l of lines) { const oid = m2oId(l.order_id); if (!oid) continue; if (!lineasDeOC.has(oid)) lineasDeOC.set(oid, []); lineasDeOC.get(oid).push(l); }
  function repartoArribos(p) {
    const lista = arribosDe(p);
    if (lista.length <= 1) return lista.map((a) => ({ arribo: a, pct: 100, fuente: 'oc' }));
    const m = piezasArribo.get(p.id) || new Map();
    const tot = lista.reduce((s, a) => s + ((m.get(a) || {}).dem || 0), 0);
    // Sin recepciones etiquetadas no hay forma de saber qué llegó en cada arribo: no se reparte (nada estimado)
    if (!(tot > 0)) return lista.map((a) => ({ arribo: a, pct: null, fuente: 'sin_datos' }));
    const partes = lista.map((a) => {
      const x = m.get(a) || { dem: 0, rec: 0, prods: new Set(), valor: 0 };
      return { arribo: a, fuente: 'recepciones', dem: x.dem, rec: x.rec, skus: x.prods.size, valor: x.valor };
    });
    // Lo que falta por recibir y no está en ninguna recepción etiquetada → "Sin arribo asignado", producto por producto.
    // Solo si la OC no está cerrada: si ya está "Recibida", el faltante se canceló en Odoo y no se espera.
    if (p.receipt_status !== 'full') {
      let dem = 0, valor = 0; const prods = new Set();
      for (const l of (lineasDeOC.get(p.id) || [])) {
        const resto = Math.max(0, (Number(l.product_qty) || 0) - (demEtiquetadaLinea.get(l.id) || 0));
        if (resto > 0) { dem += resto; valor += resto * (precioLinea.get(l.id) || 0); if (l.product_id) prods.add(m2oId(l.product_id)); }
      }
      if (dem > 0) {
        const recTag = partes.reduce((s, x) => s + x.rec, 0);
        const recOC = (polq.get(p.id) || {}).rec || 0;
        partes.push({ arribo: '', fuente: 'pendiente', dem, rec: Math.max(0, recOC - recTag), skus: prods.size, valor });
      }
    }
    const pcts = pctsCien(partes.map((x) => x.dem));
    partes.forEach((x, i) => { x.pct = pcts[i]; });
    return partes;
  }
  const poByName = new Map(pos.map((p) => [p.name, p]));
  const contById = new Map(conts.map((c) => [c.id, c]));
  const montoMxn = (p) => (p.currency_rate ? p.amount_total / p.currency_rate : null);

  // --- pares contenedor ↔ OC (equivalente a pairs: origin separado por comas) ---
  const pairs = new Set();
  for (const sp of picks) {
    const cid = m2oId(sp.container_id); if (!cid) continue;
    for (const po of splitOrigin(sp.origin)) pairs.add(cid + '|' + po);
  }
  const contsDeOC = new Map();   // po_name → [container ids]
  const ocsDeCont = new Map();   // container id → Set(po_name)
  for (const k of pairs) {
    const i = k.indexOf('|'); const cid = Number(k.slice(0, i)); const po = k.slice(i + 1);
    if (!contsDeOC.has(po)) contsDeOC.set(po, []);
    contsDeOC.get(po).push(cid);
    if (!ocsDeCont.has(cid)) ocsDeCont.set(cid, new Set());
    ocsDeCont.get(cid).add(po);
  }

  // --- pagos por OC (equivalente a bills/pay) ---
  const pay = new Map();
  for (const b of bills) {
    for (const po of splitOrigin(b.invoice_origin)) {
      let a = pay.get(po);
      if (!a) { a = { n: 0, pend: 0, allPaid: true, anyPartial: false, anyPaid: false }; pay.set(po, a); }
      const paid = ['paid', 'in_payment', 'reversed'].includes(b.payment_state);
      a.n += 1; a.pend += Number(b.amount_residual) || 0;
      a.allPaid = a.allPaid && paid; a.anyPaid = a.anyPaid || paid;
      a.anyPartial = a.anyPartial || b.payment_state === 'partial';
    }
  }

  // --- _todos ---
  const rankState = { purchase: 0, done: 0, draft: 1, cancel: 2 };
  const todos = pos
    .filter((p) => ['purchase', 'done', 'draft', 'cancel'].includes(p.state))
    .sort((a, b) => (rankState[a.state] - rankState[b.state]) || String(a.date_order).localeCompare(String(b.date_order)))
    .map((p) => {
      const q = polq.get(p.id) || { ped: 0, rec: 0, prods: new Set() };
      const pg = pay.get(p.name);
      let estatus = 'sin_factura';
      if (pg) estatus = pg.allPaid ? 'pagada' : (pg.anyPartial || (pg.anyPaid && !pg.allPaid)) ? 'parcial' : 'no_pagada';
      const cids = contsDeOC.get(p.name) || [];
      const c = cids.length ? contById.get(Math.max(...cids)) : null;
      const mx = montoMxn(p);
      return {
        name: p.name,
        proveedor: str(p.x_nombre_prov),
        fecha: dateLocal(p.date_order),
        receipt_status: p.state === 'cancel' ? 'cancel' : str(p.receipt_status),
        amount_total: mx === null ? null : round2(mx),
        piezas_pedidas: Math.round(q.ped),
        piezas_recibidas: Math.round(q.rec),
        monto_pendiente: pg ? round2(pg.pend) : 0,
        estatus_pago: estatus,
        fecha_planeada: dateLocal(p.date_planned),
        fecha_produccion: dateLocal(p.x_studio_fecha_de_produccin),
        currency_rate: p.currency_rate,
        estado_oc: p.state === 'done' ? 'purchase' : p.state,   // "Bloqueada" en Odoo = confirmada
        arribo: str(p.x_nombre_arribo_oc),
        // Por arribo, sin estimaciones:
        //  - OC de un solo arribo: valores completos de la OC (monto = total de la OC en MXN).
        //  - OC dividida con recepciones etiquetadas: piezas, recibidas y SKUs de esas recepciones; monto =
        //    Σ piezas × precio unitario de cada producto en la OC, convertido con el tipo de cambio de la OC.
        //  - OC dividida sin recepciones etiquetadas: null (el tablero muestra "—"); no se reparte.
        //  - pct: % de las piezas de la OC en esa parte, 1 decimal, suman 100.0. Si la OC sigue abierta, lo que no está en
        //    ninguna recepción etiquetada aparece como parte "pendiente" con arribo '' (Sin arribo asignado).
        arribos_detalle: repartoArribos(p).map((d) => {
          if (d.fuente === 'oc') {
            return { arribo: d.arribo, pct: 100, piezas: Math.round(q.ped), piezas_recibidas: Math.round(q.rec),
              skus: q.prods.size, monto: mx === null ? 0 : round2(mx), fuente: 'oc' };
          }
          if (d.fuente === 'recepciones' || d.fuente === 'pendiente') {
            return { arribo: d.arribo, pct: d.pct,
              piezas: Math.round(d.dem), piezas_recibidas: Math.round(d.rec), skus: d.skus,
              monto: p.currency_rate ? round2(d.valor / p.currency_rate) : null, fuente: d.fuente };
          }
          return { arribo: d.arribo, pct: null, piezas: null, piezas_recibidas: null, skus: null, monto: null, fuente: 'sin_datos' };
        }),
        container_name: c ? c.name : null,
        container_estado: c ? str(c.estado) : null,
        container_transporte: c ? str(c.transport_type) : null,
        container_eta: c ? dateLocal(c.expected_date) : null,
        container_llegada: c ? dateOnly(c.arrival_date) : null,
        comprador_id: m2oId(p.user_id),
        comprador_nombre: m2oName(p.user_id),
        num_skus: q.prods.size,
      };
    });

  // --- gastos por costo de importación ---
  const lineasPorCosto = new Map();
  for (const l of lcl) {
    if (!l.name) continue;
    const k = m2oId(l.cost_id);
    if (!lineasPorCosto.has(k)) lineasPorCosto.set(k, []);
    lineasPorCosto.get(k).push(l);
  }

  // --- containers ---
  const containers = conts
    .slice()
    .sort((a, b) => ((ESTADO_RANK[a.estado] ?? 5) - (ESTADO_RANK[b.estado] ?? 5))
      || String(a.expected_date || '9999').localeCompare(String(b.expected_date || '9999')))
    .map((cm) => {
      const ocs = [...(ocsDeCont.get(cm.id) || [])].map((n) => poByName.get(n)).filter(Boolean);
      const lineasCosto = lineasPorCosto.get(m2oId(cm.landed_cost_id)) || [];
      const deRecep = (picksPorCont.get(cm.id) || []).flatMap(nombresArriboPick);
      const arribos = [...new Set(deRecep.length ? deRecep : ocs.flatMap(arribosDe))].sort();
      return {
        id: cm.id,
        name: cm.name,
        estado: str(cm.estado),
        transporte: str(cm.transport_type),
        pickup: dateOnly(cm.pickup_date),
        shipment: dateOnly(cm.shipment_date),
        customs: dateOnly(cm.customs_date),
        clearance: dateOnly(cm.clearance_date),
        arrival: dateOnly(cm.arrival_date),
        eta: dateLocal(cm.expected_date),
        num_ocs: ocs.length || null,
        ocs: ocs.map((p) => p.name).sort(),   // folios de las OCs que trae (para el buscador del tracker)
        monto_mxn: ocs.length ? round2(ocs.reduce((s, p) => s + (montoMxn(p) || 0), 0)) : null,
        arribos: arribos.length ? arribos.join(' | ') : null,
        piezas: ocs.length ? Math.round(ocs.reduce((s, p) => s + ((polq.get(p.id) || {}).ped || 0), 0)) : null,
        gasto_logistico: lineasCosto.length ? round2(lineasCosto.reduce((s, l) => s + (Number(l.price_unit) || 0), 0)) : null,
        estado_inferido: !!cm.estado_inferido,
        estado_odoo: str(cm.estado_odoo),
        transportista_id: m2oId(cm.shipment_by),
        transportista_nombre: m2oName(cm.shipment_by),
        aduana_id: m2oId(cm.customs),
        aduana_nombre: m2oName(cm.customs),
      };
    });

  // --- gastosDesglose ---
  const gastosDesglose = [];
  for (const cm of conts.slice().sort((a, b) => a.id - b.id)) {
    const k = m2oId(cm.landed_cost_id); if (!k) continue;
    for (const l of (lineasPorCosto.get(k) || [])) {
      gastosDesglose.push({ container_id: cm.id, container_name: cm.name, concepto: initcap(l.name), monto: round2(l.price_unit) });
    }
  }

  // --- costeoExtra ---
  const costeoExtra = {};
  for (const [cid, set] of ocsDeCont) {
    const ocs = [...set].map((n) => poByName.get(n)).filter(Boolean);
    if (!ocs.length) continue;
    const provs = [...new Set(ocs.map((p) => p.x_nombre_prov).filter(Boolean))].sort();
    costeoExtra[String(cid)] = {
      skus: ocs.reduce((s, p) => s + ((polq.get(p.id) || {}).prods || new Set()).size, 0),
      num_prov: provs.length,
      proveedores: provs.join(' · ') || null,
    };
  }

  return { _todos: todos, containers, gastosDesglose, costeoExtra, snapshot: new Date().toISOString(), fuente: 'odoo' };
}

module.exports = async (req, res) => {
  const fresh = req.query && (req.query.fresh === '1' || req.query.fresh === 'true' || /^\d+$/.test(String(req.query.fresh || '')));
  try {
    const faltan = ['ODOO_URL', 'ODOO_DB', 'ODOO_USER', 'ODOO_API_KEY'].filter((k) => !process.env[k]);
    if (faltan.length) {
      res.setHeader('Cache-Control', 'no-store');
      res.status(500).json({ error: 'Faltan variables de entorno en Vercel: ' + faltan.join(', ') });
      return;
    }
    const data = await construir();
    res.setHeader('Cache-Control', fresh ? 'no-store' : 's-maxage=120, stale-while-revalidate=60');
    res.status(200).json(data);
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};

module.exports._construir = construir; // para pruebas
