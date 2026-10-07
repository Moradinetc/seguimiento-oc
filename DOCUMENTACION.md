# Seguimiento OC · Control Directivos

> Tablero para Dirección y Compras que muestra, en vivo desde BigQuery, el estado de cada orden de compra (OC): si ya llegó, si ya se pagó, en qué contenedor viene, cuándo llega y cuánto costó traerla.

## 1. Ficha rápida

| | |
|---|---|
| **Qué es** | Dashboard de solo lectura (HTML/JS de un archivo + 1 function serverless) |
| **Usuarios** | Dirección y gerencias; equipo de Compras e Importaciones. ⚠️ Por confirmar: lista exacta de usuarios |
| **URL de producción** | https://seguimiento-oc.vercel.app/ |
| **Código fuente** | GitHub `Moradinetc/seguimiento-oc` (privado), rama `main` |
| **Hosting** | Vercel — proyecto `seguimiento-oc`, equipo `etcetera-accesorios` |
| **Fuentes de datos** | BigQuery `odooconnector-491517.odoo_data` (copia de las tablas de Odoo 18) |
| **Responsable** | Coordinación de Sistemas (IT) |
| **Estado** | En producción |
| **Documentado** | 07/10/2026 — código del primer deploy en Vercel |

Versión anterior: un snapshot estático en Netlify (`lambent-pothos-bb13c2.netlify.app`) con los datos incrustados en el HTML. Desde el 07/10/2026 la versión vigente es la de Vercel con datos en vivo.

## 2. Para qué sirve

Las compras de etcétera se hacen sobre todo a proveedores en China y llegan en contenedores marítimos, aéreos o terrestres. Antes, saber "¿qué tenemos comprado, qué ya llegó, qué está pagado y qué viene en camino?" implicaba cruzar a mano varias pantallas de Odoo (Compras, Inventario, Contabilidad y el módulo de contenedores).

Este tablero junta esa información en un solo lugar. Dirección lo usa para ver el monto comprometido, el avance de recepción y pagos y los embarques atrasados. Compras e Importaciones lo usan para dar seguimiento a cada contenedor y para revisar cuánto pesan los gastos de logística e impuestos sobre el valor de la mercancía (costeo por arribo).

Es de **solo lectura**: no modifica nada en Odoo ni en BigQuery.

## 3. Glosario

| Término | Significado |
|---|---|
| **OC** | Orden de compra en Odoo (`purchase.order`, nombres como `P00123`). |
| **Cotización** | OC en estado `draft` (aún no confirmada). Se muestra aparte, no cuenta en los totales. |
| **OC aprobada** | OC confirmada, `state = 'purchase'`. Son las que suman en el tablero. |
| **Recepción** | `receipt_status` de la OC en Odoo: `full` (completa), `partial` (parcial) y cualquier otro valor (`pending`/vacío) = no recibida. |
| **Arribo** | Nombre del embarque al que se asigna la OC (`x_nombre_arribo_oc`, campo personalizado). Un arribo agrupa varias OCs. |
| **Contenedor** | Registro del modelo de contenedores de Odoo (`containers_move`), con nombres como `RCP/IN/0026`. Se liga a las OCs a través de las recepciones (`stock_picking`). |
| **Estados de contenedor** | `or` En origen · `tr` En tránsito · `ad` En aduana · `de` Despachado · `ar` Arribado. |
| **Transporte** | `ma` Marítimo · `ai` Aéreo · `te` Terrestre. |
| **ETA** | Fecha estimada de llegada del contenedor (`expected_date`). |
| **Landed cost / costeo** | Gastos de importación prorrateados a la mercancía (`stock_landed_cost_lines`): impuestos y gastos operativos. |
| **PRV, IGI, DTA** | Impuestos de importación: prevalidación, impuesto general de importación y derecho de trámite aduanero. |
| **CEDIS** | Almacén central de etcétera, destino de los contenedores. |
| **MXN** | Todos los montos se muestran en pesos: `amount_total / currency_rate` de la OC. |

## 4. Cómo se usa

La barra superior tiene cinco botones de navegación (**Resumen, Órdenes, Embarques, Gastos, Costeo**) y el botón **Periodo**.

**Filtro de periodo (global).** Al abrir **Periodo ▾** se elige *Todo*, *Este año*, un *Mes* o un *Rango personalizado* (Desde/Hasta). Filtra por **fecha de la OC** (`date_order`), así que afecta Resumen, Órdenes y Embarques por arribo. **No afecta** Tracker, Calendario, Gastos ni Costeo, porque esas vistas se organizan por contenedor y no por fecha de OC.

### 4.1 Resumen

Tiene dos sub-pestañas:

- **Recepción y pagos.** Tarjetas con número de OCs, monto total, recibidas completas, parciales y no recibidas, y estatus de pago (pagadas, no pagadas, parciales, sin factura, monto pendiente). Cada tarjeta trae una pastilla con *piezas · monto* del grupo. Si hay cotizaciones, aparece una barra delgada con su conteo.
- **Producción y logística.** Pendientes de llegar, atrasadas, por llegar, en producción, producción programada y sin dato de producción.

Debajo están la tabla **Estatus general de compras** (pendientes, aprobadas, en tránsito, recibidas, canceladas, con OCs, piezas, SKU's y monto), **Proveedores por monto** (todos, ordenados de mayor a menor), **Próximas llegadas** (los 6 contenedores no arribados con ETA más cercana) y la gráfica **OCs y monto por mes**: barras = número de OCs, línea dorada = monto, por mes de `date_order`.

### 4.2 Órdenes

Tabla detallada de OCs aprobadas con filtros agrupados: **Recepción** (todas/recibidas/parciales/no recibidas), **Pago** (todas/pagadas/no pagadas/parcial/sin factura) y **Otros** (atrasadas, en producción).

- **✕ Limpiar** quita los filtros.
- **⬇ Exportar Excel** descarga `ordenes-de-compra.csv` (UTF-8 con BOM para que Excel respete los acentos).

Las columnas OC y Proveedor quedan fijas al desplazar en horizontal. La barra de totales vive fuera del área con scroll para que siempre se vea. Cualquier columna se ordena con clic en el encabezado (primero de mayor a menor). La tabla se pagina con ← Anterior / Siguiente →.

### 4.3 Embarques

Un selector alterna dos vistas:

- **Embarques por arribo.** OCs agrupadas por `arribo`, con recibidas, parciales, no recibidas, piezas y monto. Al dar clic en un arribo se ven sus OCs.
- **Tracker de embarques.** Un renglón por contenedor: estatus, ubicación estimada, puntualidad, transporte, piezas, ETA, llegada real, días transcurridos, días de retraso, % de avance, OCs, monto, gasto logístico, % del gasto sobre el producto, transportista y aduana. Se filtra por estatus y por puntualidad (selects de color) y se ordena por cualquier columna.

### 4.4 Calendario (inaccesible en la versión actual)

El código incluye un calendario mensual de llegadas (panel `#tabCalendario`, funciones `renderCalendario()` y `renderCalDetalle()`). Muestra OCs por fecha planeada, salidas de origen, ETAs, llegadas reales y días con atraso, y abre un detalle por día. Sin embargo, **la versión desplegada no tiene ningún botón que lo abra**: el ícono que lo mostraba se perdió en una edición y solo quedó su CSS (`.cal-icon-btn`). Para restaurarlo hay que agregar un botón que llame `mostrarPanelEmb('calendario')`. Ver secciones 14 y 16.

### 4.5 Gastos

Total de gastos logísticos y su porcentaje sobre el valor de la mercancía de esos contenedores. Separa **impuestos (PRV·IGI·DTA)** de **gastos operativos**, los reparte por tipo de transporte y lista cada concepto con número de líneas, monto y % del total. Los conceptos de *demora*, *almacenaje* y *sobrestadía* se consideran evitables.

### 4.6 Costeo

Una tarjeta por arribo/contenedor con el desglose tipo "hoja de costeo": factura (valor de la OC en MXN), cada impuesto, subtotal de impuestos, cada gasto, subtotal de gastos, total de logística, **TOTAL COMPRA** y el reparto Producto % / Logística %. También muestra SKUs, número de proveedores y días de tránsito.

Filtro *Con costeo logístico* (por defecto) o *Todos los arribos*, y buscador por arribo, contenedor o proveedor. El IVA de importación aparece como "no en Odoo" porque no se registra ahí.

### 4.7 Otros elementos

- **Botón ?** (arriba a la derecha, `#btnAyuda`): abre el manual de usuario `manual.html` en otra pestaña. Funciona aunque los datos no hayan cargado, porque está en el encabezado y no depende de la API.
- El pie indica la hora de la última consulta: *"En vivo desde BigQuery · actualizado dd/mm/aaaa hh:mm · N contenedores"*.

## 5. Arquitectura

```mermaid
flowchart LR
  U["Usuario (navegador)"] -->|"abre"| H["index.html (Vercel, estático)"]
  H -->|"fetch /api/oc-data"| F["Function api/oc-data.js (Vercel, Node)"]
  F -->|"service account dashboard-plannernuevo"| BQ[("BigQuery odooconnector-491517.odoo_data")]
  O["Odoo 18 (etcetera.xmarts.net)"] -.->|"réplica de tablas"| BQ
  G["GitHub Moradinetc/seguimiento-oc"] -->|"push a main = deploy"| H
```

El navegador descarga `index.html`, que no trae datos. Al cargar, llama a `/api/oc-data`. Esa function corre en los servidores de Vercel y se autentica contra BigQuery con un service account cuyas credenciales están en variables de entorno de Vercel. Lanza **4 consultas en paralelo** y regresa un solo JSON. El navegador hace todo lo demás (filtros, KPIs, gráficas, ordenamiento) en memoria.

**Frescura:** Vercel guarda la respuesta 5 minutos (`s-maxage=300`) y puede servir la anterior hasta 10 minutos más mientras refresca en segundo plano (`stale-while-revalidate=600`). Por eso un cambio en BigQuery tarda como máximo unos 5 minutos en verse. La frescura de BigQuery respecto a Odoo depende de la réplica Odoo → BigQuery. ⚠️ Por confirmar: herramienta y frecuencia de esa sincronización.

## 6. Fuentes de datos y reglas de negocio

### 6.1 Fuentes

Todas son tablas de BigQuery en `odooconnector-491517.odoo_data`, región US, y se usan solo para lectura.

| Tabla | Modelo de Odoo | Para qué se usa |
|---|---|---|
| `purchase_order` | `purchase.order` | OCs: proveedor, fechas, estado, monto, tipo de cambio, arribo, comprador |
| `purchase_order_line` | `purchase.order.line` | Piezas pedidas y recibidas, SKUs distintos por OC |
| `stock_picking` | `stock.picking` | Liga contenedor ↔ OC (campo `origin` + `container_id`) |
| `containers_move` | modelo de contenedores (personalizado) | Estado, transporte, fechas del contenedor, liga a landed cost |
| `stock_landed_cost_lines` | `stock.landed.cost.lines` | Conceptos y montos de gastos de importación |
| `account_move` | `account.move` | Facturas de proveedor: estatus de pago y saldo pendiente |

### 6.2 Consultas (en `api/oc-data.js`)

La respuesta JSON tiene estas llaves: `_todos`, `containers`, `gastosDesglose`, `costeoExtra` y `snapshot`. El código completo de cada consulta está en las constantes `SQL_TODOS`, `SQL_CONTAINERS`, `SQL_GASTOS` y `SQL_COSTEO`.

- **`SQL_TODOS` → `_todos`**: una fila por OC en estado `purchase`, `draft` o `cancel`. Agrega piezas y SKUs de las líneas, el último contenedor ligado (mayor `id`) y el estatus de pago a partir de sus facturas. El front la separa en `ordenes` (`purchase`), `cotizaciones` (`draft`) y `canceladas` (`cancel`).
- **`SQL_CONTAINERS` → `containers`**: una fila por contenedor, con sus fechas (pickup, shipment, customs, clearance, arrival y ETA), número de OCs, monto en MXN, piezas, arribos (unidos con `|`) y gasto logístico total. Ordena por estado y ETA.
- **`SQL_GASTOS` → `gastosDesglose`**: una fila por línea de landed cost (`container_id`, `concepto` en `INITCAP`, `monto`).
- **`SQL_COSTEO` → `costeoExtra`**: por contenedor, la suma de SKUs, el número de proveedores y la lista de proveedores separados por `·`.

**Trampas conocidas del modelo de datos:**

- `stock_picking.origin` y `account_move.invoice_origin` pueden traer **varias OCs separadas por coma**. Por eso se usa `UNNEST(SPLIT(campo, ','))` con `TRIM`. Si se cambia a una igualdad simple, se pierden OCs.
- Las fechas tipo timestamp se convierten con `FORMAT_TIMESTAMP(..., 'America/Mexico_City')`. Sin eso, las OCs de la noche caen en el día siguiente.
- El monto en MXN es `amount_total / currency_rate`. En Odoo, `currency_rate` es "unidades de moneda de la OC por 1 MXN".

### 6.3 Cálculos y reglas

| Indicador / estatus | Regla | Origen |
|---|---|---|
| Recibida / parcial / no recibida | `receipt_status` = `full` / `partial` / cualquier otro | `purchase_order.receipt_status` |
| Estatus de pago | Sin facturas publicadas → **sin factura**. Todas en `paid`, `in_payment` o `reversed` → **pagada**. Alguna `partial`, o mezcla de pagadas y no pagadas → **parcial**. El resto → **no pagada** | `account_move` (`move_type='in_invoice'`, `state='posted'`) |
| Monto pendiente | Suma de `amount_residual` de sus facturas publicadas | `account_move` |
| Estatus general | `cancel` → cancelada; `draft` → pendiente; recepción `full` → recibida; contenedor `tr` o `ad` → en tránsito; si no → aprobada | Función `estatusGeneral` |
| Atrasada (OC) | No recibida completa y `fecha_planeada` anterior a hoy | `date_planned` |
| Producción | No recibida completa: sin `fecha_produccion` → sin dato; fecha ≤ hoy → en producción; fecha > hoy → programada | `x_studio_fecha_de_produccin` |
| Puntualidad (contenedor) | Arribado → no aplica. En origen o sin ETA → en monitoreo. ETA vencida → **crítico**. ETA en ≤ 5 días → **alertado**. Si no → **en tiempo** | `estado`, `expected_date` |
| Días de retraso | Días desde la ETA si ya pasó y no ha arribado; si no, 0 | Función `diasRetrasoContenedor` |
| Días transcurridos | De `shipment_date` a `arrival_date`, o a hoy si no ha llegado | Función `diasTranscurridos` |
| % de avance | `or` 10 · `tr` 45 · `ad` 75 · `ar` 100 (`de` = 0, ⚠️ revisar si debería ir entre 75 y 100) | Constante `AVANCE_PCT` |
| Ubicación estimada | `or` Puerto origen · `ad` Aduana · `ar` CEDIS · `tr` según transporte (Alta mar / Tránsito aéreo / terrestre) | Función `ubicacionEstimada` |
| SKU's | Productos distintos por OC, sumados entre OCs (un mismo SKU en dos OCs cuenta dos veces) | `purchase_order_line.product_id` |
| Gasto logístico | Suma de `price_unit` de las líneas de landed cost del contenedor | `stock_landed_cost_lines` |
| Impuestos vs operativos | Conceptos `Prv`, `Igi`, `Dta` = impuestos; el resto = operativos | Constantes `CST_IMPUESTOS` / `GASTO_IMPUESTOS` |
| Total compra (costeo) | Factura (monto MXN de las OCs del contenedor) + total de logística | Función `buildCosteoCard` |
| Comprador | `user_id` traducido con la tabla fija `COMPRADOR_NOMBRE`; si no está, "Comprador #id" | `index.html`, línea ~760 |

## 7. Estructura del código

```
seguimiento-oc/
├── index.html        Todo el front: HTML, CSS y JS (~2,150 líneas, 169 KB; incluye logo y favicon en base64)
├── api/oc-data.js    Function de Vercel: 4 consultas a BigQuery → JSON
├── package.json      Dependencia @google-cloud/bigquery ^7.9.0, Node ≥ 18
├── .gitignore        node_modules, .vercel, .env*
├── manual.html       Manual de usuario final (un solo archivo con capturas incrustadas, ~1.9 MB); lo abre el botón ?
└── DOCUMENTACION.md  Este archivo (documentación técnica para IT)
```

**Arranque:** al final del `<script>`, `cargarDatosVivo()` muestra "Consultando BigQuery…", hace `fetch('/api/oc-data')` y llena las variables globales `ordenes`, `cotizaciones`, `canceladas`, `containers`, `gastosDesglose` y `costeoExtra`. Luego oculta `#loading`, muestra `#app`, escribe el pie (`#footerInfo`) y llama a `populateFilterRango()` y `render()`. Si la API falla, deja en `#loading` el mensaje de error y un botón **Reintentar**.

| Función | Qué hace |
|---|---|
| `render()` | Aplica el periodo (`applyDateFilter`) y repinta todo: KPIs, tablas, gráficas, embarques, gastos y costeo |
| `computeKPIs()` / `renderKPIs()` / `kpiCard()` | Calculan y pintan las tarjetas del Resumen |
| `renderTable()` / `filteredSorted()` / `matchesStatusFilters()` | Tabla de Órdenes con filtros, orden y paginación |
| `renderEmbarques()` / `renderContenedores()` | Embarques por arribo y Tracker |
| `renderCalendario()` / `renderCalDetalle()` | Calendario y detalle del día |
| `renderGastosLogisticos()` | Vista Gastos |
| `renderCosteo()` / `buildCosteoCard()` | Vista Costeo |
| `renderCharts()` / `renderTopProveedores()` / `renderEstatusGeneral()` / `renderProximasLlegadas()` | Bloques del Resumen |
| `enableGenericSort(tbodyId)` | Ordenamiento por clic en encabezados de cualquier tabla |
| `fmtMoney`, `fmtInt`, `fmtFecha` (dd/mm/aaaa), `fmtMoneyCompact` | Formatos |

**Navegación:** los botones `.navbtn[data-view]` activan `#view-resumen`, `#view-ordenes` o `#view-embarques`. *Gastos* y *Costeo* son paneles dentro de `#view-embarques` que se abren con `mostrarPanelEmb()`, según el mapa `NAV_PANEL`.

**Externos:** solo Google Fonts (Plus Jakarta Sans y JetBrains Mono). No usa librerías de gráficas: las gráficas son SVG generados a mano.

## 8. Configuración y accesos

| Variable / credencial | Para qué | Dónde se configura | Quién la administra |
|---|---|---|---|
| `BQ_CLIENT_EMAIL` | Correo del service account: `dashboard-plannernuevo@odooconnector-491517.iam.gserviceaccount.com` | Vercel → proyecto → Settings → Environment Variables | Sistemas |
| `BQ_PRIVATE_KEY` | Llave privada de ese service account, completa, de `-----BEGIN PRIVATE KEY-----` a `-----END PRIVATE KEY-----\n` | Igual que la anterior | Sistemas |
| Service account `dashboard-plannernuevo` | Lectura de BigQuery. Necesita *BigQuery Job User* y *BigQuery Data Viewer* | Google Cloud → IAM → Cuentas de servicio | Sistemas |

El mismo service account lo usa también el **Planner x SKU**, aunque cada sistema tiene su propia llave. Rotar o borrar la llave de este proyecto no afecta al Planner; quitarle roles a la cuenta sí afecta a los dos.

**Accesos que necesita alguien nuevo:** colaborador en el repo `Moradinetc/seguimiento-oc` (GitHub), miembro del equipo `etcetera-accesorios` en Vercel y, para cambiar consultas, acceso de lectura a BigQuery en el proyecto `odooconnector-491517`. Se piden a Coordinación de Sistemas.

## 9. Despliegue

### 9.1 Producción

1. Haz el cambio y pasa el QA (sección 12).
2. Sube los archivos modificados a `main` en GitHub: **Add file → Upload files** reemplaza el archivo, o haz `git push`.
3. Vercel detecta el commit y despliega solo, en menos de 1 minuto. El avance se ve en Vercel → proyecto → Deployments.
4. Verifica abriendo `https://seguimiento-oc.vercel.app/api/oc-data` (debe empezar con `{"_todos":[`) y el tablero (el pie debe decir "En vivo… actualizado" con la hora actual).

La configuración del proyecto en Vercel es Framework Preset **Other**, sin build command. Vercel publica `index.html` como estático y `api/*.js` como functions.

### 9.2 Probar en local

```bash
npm i -g vercel
cd seguimiento-oc
npm install
vercel link        # una vez, elegir el proyecto seguimiento-oc
vercel env pull    # baja las variables a .env.local (no se sube a Git)
vercel dev         # http://localhost:3000
```

Abrir `index.html` directo con doble clic **no funciona**, porque no existe `/api/oc-data`.

### 9.3 Regresar a la versión anterior

En Vercel → Deployments, elige el deploy anterior y usa **Promote to Production** (Instant Rollback). O revierte el commit en GitHub y Vercel redespliega.

## 10. Operación diaria

- No hay tareas programadas: los datos se consultan cuando alguien abre el tablero (con la caché de 5 minutos).
- **Logs:** Vercel → proyecto → Logs (filtrar por `/api/oc-data`). Los errores de la function salen ahí con el mensaje de BigQuery.
- **Costos:** cada consulta completa procesa del orden de decenas de MB en BigQuery. La caché evita que cada visita vuelva a consultar.
- **Plan de Vercel:** la cuenta está en plan **Hobby**, que según las condiciones de Vercel es para uso no comercial. Ver sección 14.

## 11. Solución de problemas

| Síntoma | Causa probable | Qué hacer |
|---|---|---|
| Pantalla "No se pudieron cargar los datos… Faltan las variables de entorno BQ_CLIENT_EMAIL / BQ_PRIVATE_KEY" | Variables no creadas, mal escritas o creadas después del último deploy | Revisarlas en Vercel → Settings → Environment Variables (entorno *Production*) y hacer **Redeploy** |
| Error con `invalid_grant`, `DECODER routines` o `error:1E08010C` | `BQ_PRIVATE_KEY` incompleta o con comillas | Pegarla de nuevo completa, con BEGIN/END y sin comillas. Si se perdió, crear otra llave del service account |
| Error `Access Denied` / `Permission denied` | Al service account le falta un rol, o se cambió de proyecto | Dar *BigQuery Job User* y *BigQuery Data Viewer* en `odooconnector-491517` |
| Error `Unrecognized name` / `Name x not found` | Cambió o se eliminó una columna en la tabla de BigQuery | Revisar el esquema con `INFORMATION_SCHEMA.COLUMNS` y ajustar la consulta en `api/oc-data.js` |
| Se queda en "Consultando BigQuery…" | La function tarda mucho o hay un error de JS en el front | Abrir la consola del navegador (F12) y los Logs de Vercel |
| Un cambio en Odoo no se ve | Caché de Vercel (≤ 5 min) o la réplica Odoo → BigQuery aún no corre | Esperar unos minutos; si persiste, revisar la réplica |
| Una OC aparece sin contenedor o con pago "sin factura" | En Odoo, la recepción no tiene `container_id`, o la factura no está publicada o no lleva la OC en `invoice_origin` | Corregir el dato en Odoo (lo hace Sistemas o el área dueña del dato) |
| Comprador aparece como "Comprador #123" | Usuario nuevo que no está en `COMPRADOR_NOMBRE` | Agregar el id y nombre en `index.html` |
| El CSV abre con acentos raros | Se abrió con otro programa o se quitó el BOM | Abrir con Excel; el archivo ya incluye BOM UTF-8 |

## 12. Cómo hacer cambios sin romper nada

1. **La versión vigente está en GitHub (`main`)**, no en copias locales ni en el Netlify viejo.
2. **QA obligatorio antes de subir.** Congela la versión que funciona, aplica el cambio en una copia, valida la sintaxis (`node --check` del JS) y corre la prueba de humo de vistas y functions, comparando antes y después (skill `qa-despliegue-etc`). Nada que funcionaba puede dejar de funcionar.
3. **No renombres** ids del HTML, funciones globales ni las llaves del JSON (`_todos`, `containers`, `gastosDesglose`, `costeoExtra`): el front depende de ellos. Agrega, no renombres.
4. **Para una consulta nueva o modificada**, pruébala primero en la consola de BigQuery (o en *dry run*) y luego cópiala a `api/oc-data.js`.
5. **Para un KPI nuevo**, calcula en `computeKPIs()` y pinta con `kpiCard()` siguiendo las tarjetas existentes.
6. **Si el dato está mal en Odoo, se corrige en Odoo.** Los cambios en Odoo de producción solo los aplica Coordinación de Sistemas.
7. **Nunca subas credenciales al repo.** `.gitignore` ya excluye `.env*`.

## 13. Relación con otros sistemas

- **Odoo 18** es la fuente original de todos los datos. Cambios en los campos personalizados (`x_nombre_arribo_oc`, `x_nombre_prov`, `x_studio_fecha_de_produccin`) o en el modelo de contenedores rompen las consultas.
- **BigQuery `odoo_data`** lo comparten varios dashboards (Dashboard Comercial, Planner x SKU, Landed Cost tracker y otros). Un cambio de esquema afecta a todos.
- **Service account `dashboard-plannernuevo`**: compartido con el Planner x SKU (ver sección 8).
- **Landed Cost tracker** y **Tracking cadena de suministros** muestran información parecida (costeo y marítimos). Si cambia una regla de negocio, hay que revisar que coincida en los tres.

## 14. Limitaciones conocidas y pendientes

- **Plan Hobby de Vercel** para uso comercial: conviene pasarlo a Pro.
- El **conector de Vercel en Claude** no tiene acceso al equipo `etcetera-accesorios`, así que los despliegues se hacen por GitHub. Pendiente reautorizarlo.
- `COMPRADOR_NOMBRE` es una tabla fija en el código. Lo ideal es traer el nombre desde `res_users`/`res_partner` en BigQuery.
- Transportista y aduana se muestran como `#id`, no por nombre.
- El IVA de importación no está en Odoo, así que el Costeo no lo incluye.
- El estado `de` (Despachado) tiene 0 % de avance en `AVANCE_PCT`. ⚠️ Revisar si es intencional.
- **El Calendario de llegadas no se puede abrir**: falta el botón en el HTML (sección 4.4).
- Sin control de acceso: cualquiera con la URL ve el tablero. ⚠️ Por confirmar si se debe proteger (Vercel Deployment Protection o login de Odoo RH).

## 15. Historial de cambios

| Fecha | Cambio |
|---|---|
| 07/10/2026 | Botón **?** en el encabezado que abre el manual de usuario (`manual.html`); se agregan `manual.html` y `DOCUMENTACION.md` al repo |
| 07/10/2026 | Migración a Vercel con datos en vivo desde BigQuery (`/api/oc-data`); repo `Moradinetc/seguimiento-oc` |
| 06/10/2026 | Último snapshot estático (507 OCs, 61 contenedores) en Netlify |
| oct 2026 | Rediseño: navegación plana, periodo en popover, logo, Manual, Órdenes con filtros agrupados, export CSV, columnas fijas y totales fuera del scroll |
| jul 2026 | Primera versión del seguimiento de órdenes de compra |

## 16. Preguntas abiertas

1. ¿Quiénes son los usuarios exactos del tablero y quién decide los accesos? (Dirección)
2. ¿Con qué herramienta y cada cuánto se replica Odoo a BigQuery? (Sistemas)
3. ¿El estado `de` (Despachado) debe tener un % de avance entre 75 y 100? (Importaciones)
4. ¿Se debe proteger la URL con login? (Dirección / Sistemas)
5. ¿Se pasa el proyecto a un plan Pro de Vercel? (Sistemas / Finanzas)
6. ¿Se restaura el botón del **Calendario** de llegadas? (Sistemas)

---

**Manual de usuario:** si cambia una pantalla, un botón o una regla visible para el usuario, actualiza también `manual.html`. Se regenera con la skill `manual-usuario-etc` (capturas automáticas con datos de prueba).
