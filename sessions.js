'use strict';

const config = require('./config');
const db = require('./database');

/**
 * Registro persistente de sesiones de carga (tabla charge_sessions).
 *
 * Antes la sesión se recalculaba en cada request integrando las últimas
 * 100 mediciones: no quedaba historial y una carga larga "perdía" su
 * inicio cuando se salía de esa ventana. Ahora el servidor integra la
 * energía medición a medición y guarda cada carga:
 *
 *  - Se ABRE cuando la corriente supera config.session.startThresholdMa, o
 *    cuando un ESP32 con relé reporta "cargando" (lo que pase primero).
 *  - Se CIERRA cuando la corriente queda bajo el umbral por
 *    config.session.endBelowForMs (salvo que el ESP32 siga diciendo
 *    "cargando"), cuando el ESP32 reporta "finalizada", o cuando el
 *    cargador deja de mandar datos (config.status.offlineAfterMs).
 *
 * Al abrir se copia quién pidió cargar (la solicitud vigente), el precio
 * por kWh (el del cargador, o el general), la comisión de CargaCerca y la
 * escala de demo, así el monto de una carga ya hecha no cambia si después
 * cambia la configuración.
 */

const q = {
  open: db.prepare('SELECT * FROM charge_sessions WHERE charger_id = ? AND ended_at IS NULL'),
  insert: db.prepare(`
    INSERT INTO charge_sessions
      (charger_id, driver_id, driver_name, card_uid, started_at, last_at,
       last_current_ma, last_power_mw, peak_power_mw, energy_wh,
       energy_scale, price_per_kwh, commission_rate, currency)
    VALUES
      (@charger_id, @driver_id, @driver_name, @card_uid, @started_at, @last_at,
       @last_current_ma, @last_power_mw, @last_power_mw, 0,
       @energy_scale, @price_per_kwh, @commission_rate, @currency)
  `),
  update: db.prepare(`
    UPDATE charge_sessions
       SET last_at = @last_at, last_current_ma = @last_current_ma,
           last_power_mw = @last_power_mw, peak_power_mw = @peak_power_mw,
           below_since = @below_since, energy_wh = @energy_wh,
           driver_id = @driver_id, driver_name = @driver_name
     WHERE id = @id
  `),
  close: db.prepare('UPDATE charge_sessions SET ended_at = ?, end_reason = ?, below_since = NULL WHERE id = ?'),
  remove: db.prepare('DELETE FROM charge_sessions WHERE id = ?'),
  consumeRequest: db.prepare('DELETE FROM charge_requests WHERE charger_id = ? AND requested_at <= ?'),
  getById: db.prepare('SELECT * FROM charge_sessions WHERE id = ?'),
  chargerPrice: db.prepare('SELECT price_per_kwh FROM chargers WHERE charger_id = ?'),
  listForCharger: db.prepare(`
    SELECT s.*, r.rating AS review_rating, r.comment AS review_comment, r.created_at AS review_at
      FROM charge_sessions s
      LEFT JOIN driver_reviews r ON r.session_id = s.id
     WHERE s.charger_id = ?
     ORDER BY s.started_at DESC
     LIMIT ?
  `),
  statsForCharger: db.prepare(`
    SELECT COUNT(*) AS sessions,
           COALESCE(SUM(energy_wh * energy_scale), 0) AS billed_wh,
           COALESCE(SUM(energy_wh * energy_scale / 1000 * price_per_kwh), 0) AS amount,
           COALESCE(SUM(energy_wh * energy_scale / 1000 * price_per_kwh * (1 - commission_rate)), 0) AS host_net,
           SUM(CASE WHEN driver_id IS NOT NULL
                     AND NOT EXISTS (SELECT 1 FROM driver_reviews r WHERE r.session_id = s.id)
                    THEN 1 ELSE 0 END) AS pending_reviews
      FROM charge_sessions s
     WHERE charger_id = ? AND ended_at IS NOT NULL
  `),
};

const ts = (iso) => Date.parse(iso);

/** Monto de la carga: energía (con la escala de demo) × precio por kWh. */
function amountOf(row) {
  return Math.round(((row.energy_wh * row.energy_scale) / 1000) * row.price_per_kwh * 100) / 100;
}

/** Lo que le queda al anfitrión después de la comisión de CargaCerca. */
const hostNetOf = (row) => Math.round(amountOf(row) * (1 - (row.commission_rate || 0)) * 100) / 100;

/** Precio vigente de un cargador: el que puso el anfitrión, o el general. */
function priceFor(chargerId) {
  const c = q.chargerPrice.get(chargerId);
  return c && c.price_per_kwh != null ? c.price_per_kwh : config.client.pricePerKwh;
}

function openSession(chargerId, atMs, latest, request, cardUid) {
  q.insert.run({
    charger_id: chargerId,
    driver_id: request ? request.driverId : null,
    driver_name: request ? request.name : null,
    card_uid: cardUid || null,
    started_at: new Date(atMs).toISOString(),
    last_at: new Date(atMs).toISOString(),
    last_current_ma: latest ? Number(latest.current_ma) || 0 : 0,
    last_power_mw: latest ? Number(latest.power_mw) || 0 : 0,
    energy_scale: config.client.energyScale,
    price_per_kwh: priceFor(chargerId),
    commission_rate: config.business.commissionRate,
    currency: config.client.currency,
  });
}

function closeSession(row, endedAtIso, reason) {
  // Picos de corriente que no llegaron a ser una carga: no ensucian el historial.
  if (ts(endedAtIso) - ts(row.started_at) < config.session.minDurationMs) {
    q.remove.run(row.id);
    return;
  }
  q.close.run(endedAtIso, reason, row.id);
  // La solicitud que dio origen a esta carga ya se usó: la borramos para que
  // el cargador vuelva a figurar libre (el ESP32 con relé ya lo hace al
  // reportar "finalizada"; un cargador simple solo se entera por corriente).
  q.consumeRequest.run(row.charger_id, row.started_at);
}

/**
 * Cierra la sesión abierta si el cargador dejó de mandar datos. Se llama al
 * leer (no hay un timer): si el ESP32 se apagó a mitad de carga, la sesión
 * termina en la última medición que llegó.
 */
function closeIfStale(chargerId, now = Date.now()) {
  const open = q.open.get(chargerId);
  if (open && now - ts(open.last_at) > config.status.offlineAfterMs) {
    closeSession(open, open.last_at, 'sin_datos');
  }
}

/**
 * Integra una medición nueva en la sesión del cargador (o la abre).
 * @param {string} chargerId
 * @param {object} m            fila recién insertada en measurements
 * @param {object|null} request solicitud vigente { name, driverId } o null
 * @param {object|null} deviceState fila de device_status o null
 */
function onMeasurement(chargerId, m, request, deviceState) {
  const now = ts(m.created_at);
  const ma = Number(m.current_ma) || 0;
  const pmw = Number(m.power_mw) || 0;
  const startMa = config.session.startThresholdMa;

  closeIfStale(chargerId, now);
  const open = q.open.get(chargerId);

  if (!open) {
    if (ma >= startMa) openSession(chargerId, now, m, request, deviceState && deviceState.card_uid);
    return;
  }

  // Integración trapezoidal: (W promedio) * (horas)
  const dtH = (now - ts(open.last_at)) / 3600000;
  const energyWh = open.energy_wh + (dtH > 0 ? ((open.last_power_mw + pmw) / 2 / 1000) * dtH : 0);

  // Si la carga arrancó antes de que llegara la solicitud, la asociamos igual.
  const driverId = open.driver_id || (request ? request.driverId : null);
  const driverName = open.driver_name || (request ? request.name : null);

  let belowSince = open.below_since;
  if (ma >= startMa) belowSince = null;
  else if (!belowSince) belowSince = m.created_at;

  q.update.run({
    id: open.id,
    last_at: m.created_at,
    last_current_ma: ma,
    last_power_mw: pmw,
    peak_power_mw: Math.max(open.peak_power_mw || 0, pmw),
    below_since: belowSince,
    energy_wh: energyWh,
    driver_id: driverId,
    driver_name: driverName,
  });

  // Un ESP32 con relé que sigue en "cargando" manda: el auto puede bajar la
  // corriente un rato (batería casi llena) sin que la carga haya terminado.
  const deviceSaysCharging =
    deviceState &&
    deviceState.state === 'cargando' &&
    now - ts(deviceState.updated_at) <= config.status.offlineAfterMs;

  if (belowSince && !deviceSaysCharging && now - ts(belowSince) >= config.session.endBelowForMs) {
    closeSession({ ...open, energy_wh: energyWh }, belowSince, 'corriente');
  }
}

/** Transiciones que reporta un ESP32 con NFC + relé. */
function onDeviceState(chargerId, state, request, cardUid, latest, now = Date.now()) {
  closeIfStale(chargerId, now);
  const open = q.open.get(chargerId);
  if (state === 'cargando' && !open) {
    openSession(chargerId, now, latest, request, cardUid);
  } else if (state === 'finalizada' && open) {
    closeSession(open, new Date(now).toISOString(), 'dispositivo');
  }
}

/**
 * Sesión en curso (o null). energyWh es lo medido; billedEnergyWh y amount
 * ya traen la escala de demo y el precio, así la vista cliente y el panel
 * muestran exactamente lo que después queda en el historial.
 */
function currentSession(chargerId) {
  const row = q.open.get(chargerId);
  if (!row) return null;
  return {
    id: row.id,
    start: row.started_at,
    durationMs: ts(row.last_at) - ts(row.started_at),
    currentMa: row.last_current_ma,
    powerMw: row.last_power_mw,
    energyWh: Math.round(row.energy_wh * 10000) / 10000,
    billedEnergyWh: Math.round(row.energy_wh * row.energy_scale * 100) / 100,
    pricePerKwh: row.price_per_kwh,
    currency: row.currency,
    amount: amountOf(row),
    driverName: row.driver_name,
  };
}

/**
 * Sesión para el panel. Nunca devuelve el driver_id: con él cualquiera
 * podría hacerse pasar por ese conductor (no hay login).
 */
function sessionToPublic(row, reputationOf) {
  const durationEnd = row.ended_at || row.last_at;
  return {
    id: row.id,
    chargerId: row.charger_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    endReason: row.end_reason,
    durationMs: ts(durationEnd) - ts(row.started_at),
    energyWh: Math.round(row.energy_wh * 10000) / 10000,
    billedEnergyWh: Math.round(row.energy_wh * row.energy_scale * 100) / 100,
    energyScale: row.energy_scale,
    pricePerKwh: row.price_per_kwh,
    currency: row.currency,
    amount: amountOf(row),
    hostNet: hostNetOf(row),
    commissionRate: row.commission_rate,
    peakPowerMw: row.peak_power_mw,
    driver: row.driver_name
      ? { name: row.driver_name, identified: !!row.driver_id, reputation: row.driver_id ? reputationOf(row.driver_id) : null }
      : null,
    review: row.review_rating != null
      ? { rating: row.review_rating, comment: row.review_comment, createdAt: row.review_at }
      : null,
    reviewable: !!row.ended_at && !!row.driver_id && row.review_rating == null,
  };
}

function listForCharger(chargerId, limit, reputationOf) {
  closeIfStale(chargerId);
  return q.listForCharger.all(chargerId, limit).map((row) => sessionToPublic(row, reputationOf));
}

function statsForCharger(chargerId) {
  const r = q.statsForCharger.get(chargerId);
  return {
    sessions: r.sessions,
    billedEnergyWh: Math.round(r.billed_wh * 100) / 100,
    amount: Math.round(r.amount * 100) / 100,
    hostNet: Math.round(r.host_net * 100) / 100,
    currency: config.client.currency,
    pendingReviews: r.pending_reviews || 0,
  };
}

const qSummary = {
  // ownerId null = todos los cargadores (admin). from null = desde siempre.
  totals: db.prepare(`
    SELECT COUNT(*) AS sessions,
           COALESCE(SUM(s.energy_wh * s.energy_scale), 0) AS billed_wh,
           COALESCE(SUM(s.energy_wh * s.energy_scale / 1000 * s.price_per_kwh), 0) AS amount,
           COALESCE(SUM(s.energy_wh * s.energy_scale / 1000 * s.price_per_kwh * (1 - s.commission_rate)), 0) AS host_net,
           COUNT(DISTINCT s.driver_id) AS drivers
      FROM charge_sessions s JOIN chargers c ON c.charger_id = s.charger_id
     WHERE s.ended_at IS NOT NULL
       AND (@owner IS NULL OR c.owner_id = @owner)
       AND (@from IS NULL OR s.started_at >= @from)
  `),
  byDay: db.prepare(`
    SELECT date(s.started_at, @offset) AS day,
           COUNT(*) AS sessions,
           SUM(s.energy_wh * s.energy_scale / 1000 * s.price_per_kwh) AS amount,
           SUM(s.energy_wh * s.energy_scale / 1000 * s.price_per_kwh * (1 - s.commission_rate)) AS host_net
      FROM charge_sessions s JOIN chargers c ON c.charger_id = s.charger_id
     WHERE s.ended_at IS NOT NULL
       AND (@owner IS NULL OR c.owner_id = @owner)
       AND (@from IS NULL OR s.started_at >= @from)
     GROUP BY day ORDER BY day
  `),
  pendingReviews: db.prepare(`
    SELECT COUNT(*) AS n
      FROM charge_sessions s JOIN chargers c ON c.charger_id = s.charger_id
     WHERE s.ended_at IS NOT NULL AND s.driver_id IS NOT NULL
       AND (@owner IS NULL OR c.owner_id = @owner)
       AND NOT EXISTS (SELECT 1 FROM driver_reviews r WHERE r.session_id = s.id)
  `),
  recent: db.prepare(`
    SELECT s.*, c.name AS charger_name, r.rating AS review_rating, r.comment AS review_comment, r.created_at AS review_at
      FROM charge_sessions s
      JOIN chargers c ON c.charger_id = s.charger_id
      LEFT JOIN driver_reviews r ON r.session_id = s.id
     WHERE (@owner IS NULL OR c.owner_id = @owner)
     ORDER BY s.started_at DESC
     LIMIT 10
  `),
};

/**
 * Totales y serie por día para los paneles. ownerId null = toda la red
 * (admin); si no, solo los cargadores de ese anfitrión.
 */
function summary(ownerId, fromIso, reputationOf) {
  const p = { owner: ownerId ?? null, from: fromIso ?? null };
  const t = qSummary.totals.get(p);
  const r2 = (n) => Math.round((n || 0) * 100) / 100;
  return {
    totals: {
      sessions: t.sessions,
      billedEnergyWh: r2(t.billed_wh),
      amount: r2(t.amount),
      hostNet: r2(t.host_net),
      commission: r2(t.amount - t.host_net),
      drivers: t.drivers,
      currency: config.client.currency,
      pendingReviews: qSummary.pendingReviews.get({ owner: p.owner }).n,
    },
    byDay: qSummary.byDay.all({ ...p, offset: config.business.dayOffset }).map((d) => ({
      day: d.day,
      sessions: d.sessions,
      amount: r2(d.amount),
      hostNet: r2(d.host_net),
    })),
    recent: qSummary.recent
      .all({ owner: p.owner })
      .map((row) => ({ ...sessionToPublic(row, reputationOf), chargerName: row.charger_name })),
  };
}

module.exports = {
  onMeasurement,
  onDeviceState,
  closeIfStale,
  currentSession,
  listForCharger,
  statsForCharger,
  summary,
  priceFor,
  getById: (id) => q.getById.get(id),
};
