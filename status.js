'use strict';

const config = require('./config');

/**
 * Estado del cargador, combinando:
 *  - measurements: lecturas eléctricas del INA219 (siempre existieron)
 *  - device_status: estado físico que reporta un ESP32 con NFC + relé
 *    (esperando_tarjeta / esperando_inicio / cargando / finalizada).
 *    Es opcional: un firmware simple (solo INA219, sin NFC/relé) nunca lo
 *    manda, y el estado se sigue infiriendo por corriente como antes.
 *
 * @param {object|null} latest      fila de measurements (o null)
 * @param {object|null} deviceState fila de device_status (o null)
 * @param {number} now              timestamp ms (default: Date.now())
 */
function computeStatus(latest, deviceState = null, now = Date.now()) {
  const L = config.status.labels;

  const measTs = latest ? Date.parse(latest.created_at) : null;
  const devTs = deviceState ? Date.parse(deviceState.updated_at) : null;
  const lastTs = [measTs, devTs].filter((t) => t != null).sort((a, b) => b - a)[0] ?? null;

  const base = {
    lastSeenAt: lastTs != null ? new Date(lastTs).toISOString() : null,
    ageMs: lastTs != null ? now - lastTs : null,
    deviceState: deviceState ? deviceState.state : null,
    cardUid: deviceState ? deviceState.card_uid : null,
  };

  if (lastTs == null) {
    return { status: L.neverConnected, ...base };
  }

  if (base.ageMs > config.status.offlineAfterMs) {
    return { status: L.disconnected, ...base };
  }

  // El device_status es la fuente más confiable cuando está fresco: lo
  // manda el propio ESP32 (relé real, tarjeta real leída).
  const devFresh = devTs != null && now - devTs <= config.status.offlineAfterMs;
  if (devFresh) {
    if (deviceState.state === 'esperando_tarjeta') return { status: L.waitingCard, ...base };
    if (deviceState.state === 'esperando_inicio') return { status: L.waitingStart, ...base };
    if (deviceState.state === 'finalizada') return { status: L.finished, ...base };
    if (deviceState.state === 'cargando') return { status: L.charging, ...base };
    // estado desconocido -> seguimos al fallback por corriente
  }

  // Sin device_status fresco (firmware simple sin NFC/relé): clasificar por corriente
  const ma = latest ? Number(latest.current_ma) || 0 : 0;
  let status;
  if (ma < config.status.currentAvailableBelowMa) status = L.available;
  else if (ma < config.status.currentLowBelowMa) status = L.lowConsumption;
  else status = L.charging;

  return { status, ...base };
}

/**
 * Sesión de carga actual, integrando potencia en el tiempo.
 * @param {Array<object>} rows  measurements ORDENADAS ascendente por created_at
 * @param {number} now  timestamp ms
 * @returns {null|object} { start, durationMs, currentMa, powerMw, energyWh }
 */
function computeCurrentSession(rows, now = Date.now()) {
  const startMa = config.session.startThresholdMa;
  const endMs = config.session.endBelowForMs;

  let active = false;
  let startTs = null;
  let energyWh = 0;
  let prevTs = null;
  let prevPowerMw = 0;
  let belowSince = null;
  let lastTs = null;
  let lastMa = 0;
  let lastPowerMw = 0;

  for (const r of rows) {
    const ts = Date.parse(r.created_at);
    const ma = Number(r.current_ma) || 0;
    const pmw = Number(r.power_mw) || 0;

    if (!active) {
      if (ma >= startMa) {
        active = true;
        startTs = ts;
        energyWh = 0;
        prevTs = ts;
        prevPowerMw = pmw;
        belowSince = null;
      }
    } else {
      // Integración trapezoidal: (W promedio) * (horas)
      const dtH = (ts - prevTs) / 3600000;
      if (dtH > 0) {
        const avgW = (prevPowerMw + pmw) / 2 / 1000;
        energyWh += avgW * dtH;
      }
      prevTs = ts;
      prevPowerMw = pmw;

      if (ma < startMa) {
        if (belowSince === null) belowSince = ts;
        else if (ts - belowSince >= endMs) {
          // La sesión terminó dentro del rango de datos: buscamos si empieza otra
          active = false;
          startTs = null;
          belowSince = null;
        }
      } else {
        belowSince = null;
      }
    }

    lastTs = ts;
    lastMa = ma;
    lastPowerMw = pmw;
  }

  if (!active || startTs === null) return null;

  // Si el último dato es viejo, la sesión probablemente ya no está viva
  if (lastTs !== null && now - lastTs > config.status.offlineAfterMs) return null;

  return {
    start: new Date(startTs).toISOString(),
    durationMs: (lastTs ?? startTs) - startTs,
    currentMa: lastMa,
    powerMw: lastPowerMw,
    energyWh: Math.round(energyWh * 10000) / 10000,
  };
}

module.exports = { computeStatus, computeCurrentSession };
