// Seguimiento OC — API de datos en vivo desde BigQuery (Vercel serverless)
// Variables de entorno requeridas en Vercel (Settings → Environment Variables):
//   BQ_CLIENT_EMAIL  -> client_email del service account
//   BQ_PRIVATE_KEY   -> private_key del service account (pegarla completa, con BEGIN/END)
const { BigQuery } = require('@google-cloud/bigquery');

const PROJECT = 'odooconnector-491517';
const LOCATION = 'US';
const DS = '`odooconnector-491517.odoo_data';

const SQL_TODOS = `
WITH polq AS (
  SELECT order_id, SUM(product_qty) AS piezas_pedidas, SUM(qty_received) AS piezas_recibidas, COUNT(DISTINCT product_id) AS num_skus
  FROM ${DS}.purchase_order_line\` GROUP BY order_id
),
pairs AS (
  SELECT DISTINCT sp.container_id, TRIM(o) AS po_name
  FROM ${DS}.stock_picking\` sp, UNNEST(SPLIT(sp.origin, ',')) AS o
  WHERE sp.container_id IS NOT NULL
),
cont AS (
  SELECT po_name, ARRAY_AGG(STRUCT(cm.name AS container_name, cm.estado AS container_estado, cm.transport_type AS container_transporte,
    FORMAT_TIMESTAMP('%Y-%m-%d', cm.expected_date, 'America/Mexico_City') AS container_eta, CAST(cm.arrival_date AS STRING) AS container_llegada)
    ORDER BY cm.id DESC LIMIT 1)[OFFSET(0)] AS c
  FROM pairs JOIN ${DS}.containers_move\` cm ON cm.id = pairs.container_id GROUP BY po_name
),
bills AS (
  SELECT TRIM(o) AS po_name, am.payment_state, am.amount_residual
  FROM ${DS}.account_move\` am, UNNEST(SPLIT(am.invoice_origin, ',')) AS o
  WHERE am.move_type='in_invoice' AND am.state='posted'
),
pay AS (
  SELECT po_name, COUNT(*) AS n, ROUND(SUM(amount_residual),2) AS monto_pendiente,
    LOGICAL_AND(payment_state IN ('paid','in_payment','reversed')) AS all_paid,
    LOGICAL_OR(payment_state='partial') AS any_partial,
    LOGICAL_OR(payment_state IN ('paid','in_payment','reversed')) AS any_paid
  FROM bills GROUP BY po_name
)
SELECT TO_JSON_STRING(ARRAY_AGG(STRUCT(
  po.name, po.x_nombre_prov AS proveedor,
  FORMAT_TIMESTAMP('%Y-%m-%d', po.date_order, 'America/Mexico_City') AS fecha,
  IF(po.state='cancel','cancel', po.receipt_status) AS receipt_status,
  ROUND(SAFE_DIVIDE(po.amount_total, po.currency_rate),2) AS amount_total,
  IFNULL(CAST(polq.piezas_pedidas AS INT64),0) AS piezas_pedidas,
  IFNULL(CAST(polq.piezas_recibidas AS INT64),0) AS piezas_recibidas,
  IFNULL(pay.monto_pendiente,0) AS monto_pendiente,
  CASE WHEN pay.n IS NULL THEN 'sin_factura' WHEN pay.all_paid THEN 'pagada'
       WHEN pay.any_partial OR (pay.any_paid AND NOT pay.all_paid) THEN 'parcial' ELSE 'no_pagada' END AS estatus_pago,
  FORMAT_TIMESTAMP('%Y-%m-%d', po.date_planned, 'America/Mexico_City') AS fecha_planeada,
  FORMAT_TIMESTAMP('%Y-%m-%d', po.x_studio_fecha_de_produccin, 'America/Mexico_City') AS fecha_produccion,
  po.currency_rate, po.state AS estado_oc, po.x_nombre_arribo_oc AS arribo,
  cont.c.container_name, cont.c.container_estado, cont.c.container_transporte, cont.c.container_eta, cont.c.container_llegada,
  po.user_id AS comprador_id, IFNULL(CAST(polq.num_skus AS INT64),0) AS num_skus
) ORDER BY CASE po.state WHEN 'purchase' THEN 0 WHEN 'draft' THEN 1 WHEN 'cancel' THEN 2 ELSE 3 END, po.date_order)) AS json_out
FROM ${DS}.purchase_order\` po
LEFT JOIN polq ON polq.order_id = po.id
LEFT JOIN cont ON cont.po_name = po.name
LEFT JOIN pay ON pay.po_name = po.name
WHERE po.state IN ('purchase','draft','cancel')`;

const SQL_CONTAINERS = `
WITH po AS (
  SELECT po.id, po.name, po.x_nombre_arribo_oc AS arribo, SAFE_DIVIDE(po.amount_total, po.currency_rate) AS monto_mxn
  FROM ${DS}.purchase_order\` po
),
polq AS (SELECT order_id, SUM(product_qty) AS piezas FROM ${DS}.purchase_order_line\` GROUP BY order_id),
pairs AS (
  SELECT DISTINCT sp.container_id, TRIM(o) AS po_name
  FROM ${DS}.stock_picking\` sp, UNNEST(SPLIT(sp.origin, ',')) AS o WHERE sp.container_id IS NOT NULL
),
agg AS (
  SELECT pr.container_id, COUNT(DISTINCT po.name) AS num_ocs, ROUND(SUM(po.monto_mxn),2) AS monto_mxn,
         CAST(SUM(polq.piezas) AS INT64) AS piezas, STRING_AGG(DISTINCT po.arribo, ' | ') AS arribos
  FROM pairs pr JOIN po ON po.name = pr.po_name LEFT JOIN polq ON polq.order_id = po.id GROUP BY pr.container_id
),
gasto AS (
  SELECT cm.id AS container_id, ROUND(SUM(l.price_unit),2) AS gasto_logistico
  FROM ${DS}.containers_move\` cm
  JOIN ${DS}.stock_landed_cost_lines\` l ON l.cost_id = cm.landed_cost_id
  WHERE l.name IS NOT NULL GROUP BY cm.id
)
SELECT TO_JSON_STRING(ARRAY_AGG(STRUCT(
  cm.id, cm.name, cm.estado, cm.transport_type AS transporte,
  CAST(cm.pickup_date AS STRING) AS pickup, CAST(cm.shipment_date AS STRING) AS shipment,
  CAST(cm.customs_date AS STRING) AS customs, CAST(cm.clearance_date AS STRING) AS clearance,
  CAST(cm.arrival_date AS STRING) AS arrival,
  FORMAT_TIMESTAMP('%Y-%m-%d', cm.expected_date, 'America/Mexico_City') AS eta,
  agg.num_ocs, agg.monto_mxn, agg.arribos, agg.piezas, gasto.gasto_logistico,
  cm.shipment_by AS transportista_id, cm.customs AS aduana_id
) ORDER BY CASE cm.estado WHEN 'or' THEN 0 WHEN 'tr' THEN 1 WHEN 'ad' THEN 2 WHEN 'de' THEN 3 WHEN 'ar' THEN 4 ELSE 5 END, cm.expected_date)) AS json_out
FROM ${DS}.containers_move\` cm
LEFT JOIN agg ON agg.container_id = cm.id
LEFT JOIN gasto ON gasto.container_id = cm.id`;

const SQL_GASTOS = `
SELECT TO_JSON_STRING(ARRAY_AGG(STRUCT(
  cm.id AS container_id, cm.name AS container_name, INITCAP(l.name) AS concepto, ROUND(l.price_unit,2) AS monto
) ORDER BY cm.id, l.id)) AS json_out
FROM ${DS}.containers_move\` cm
JOIN ${DS}.stock_landed_cost_lines\` l ON l.cost_id = cm.landed_cost_id
WHERE cm.landed_cost_id IS NOT NULL AND l.name IS NOT NULL`;

const SQL_COSTEO = `
WITH pairs AS (
  SELECT DISTINCT sp.container_id, TRIM(o) AS po_name
  FROM ${DS}.stock_picking\` sp, UNNEST(SPLIT(sp.origin, ',')) AS o WHERE sp.container_id IS NOT NULL
),
posk AS (
  SELECT po.id, po.name, po.x_nombre_prov AS proveedor,
    (SELECT COUNT(DISTINCT pol.product_id) FROM ${DS}.purchase_order_line\` pol WHERE pol.order_id = po.id) AS skus
  FROM ${DS}.purchase_order\` po
)
SELECT TO_JSON_STRING(ARRAY_AGG(STRUCT(container_id, skus, num_prov, proveedores))) AS json_out
FROM (
  SELECT pr.container_id, SUM(posk.skus) AS skus, COUNT(DISTINCT posk.proveedor) AS num_prov,
         STRING_AGG(DISTINCT posk.proveedor, ' · ' ORDER BY posk.proveedor) AS proveedores
  FROM pairs pr JOIN posk ON posk.name = pr.po_name GROUP BY pr.container_id
)`;

let _bq = null;
function getBQ() {
  if (_bq) return _bq;
  const pk = (process.env.BQ_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  _bq = new BigQuery({
    projectId: PROJECT,
    credentials: { client_email: process.env.BQ_CLIENT_EMAIL, private_key: pk },
  });
  return _bq;
}

async function runJson(bq, sql) {
  const [rows] = await bq.query({ query: sql, location: LOCATION });
  const s = rows && rows[0] ? rows[0].json_out : null;
  return s ? JSON.parse(s) : [];
}

module.exports = async (req, res) => {
  try {
    if (!process.env.BQ_CLIENT_EMAIL || !process.env.BQ_PRIVATE_KEY) {
      res.status(500).json({ error: 'Faltan las variables de entorno BQ_CLIENT_EMAIL / BQ_PRIVATE_KEY en Vercel.' });
      return;
    }
    const bq = getBQ();
    const [todos, containers, gastos, costeoArr] = await Promise.all([
      runJson(bq, SQL_TODOS),
      runJson(bq, SQL_CONTAINERS),
      runJson(bq, SQL_GASTOS),
      runJson(bq, SQL_COSTEO),
    ]);
    const costeoExtra = {};
    (costeoArr || []).forEach(r => {
      costeoExtra[String(r.container_id)] = { skus: r.skus, num_prov: r.num_prov, proveedores: r.proveedores };
    });
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    res.status(200).json({
      _todos: todos || [],
      containers: containers || [],
      gastosDesglose: gastos || [],
      costeoExtra,
      snapshot: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};
