'use strict';

const config = require('./config');

/**
 * Estado del cargador a partir de la última medición.
 * @param {object|null} latest  fila de measurements (o null si nunca recibió datos)
 * @param {number} now  timestamp ms (default: Date.now())
 */
function computeStatus(latest, now = Date.now()) {
  const L = config.status.labels;

  if (!latest) {
    return { status: L.neverConnected, lastSeenAt: null, ageMs: null };
  }

  const lastMs = Date.parse(latest.created_at);
  const ageMs = now - lastMs;

  if (ageMs > config.status.offlineAfterMs) {
    return { status: L.disconnected, lastSeenAt: latest.created_at, ageMs };
  }

  const ma = Number(latest.current_ma) || 0;
  let status;
  if (ma < config.status.currentAvailableBelowMa) status = L.available;
  else if (ma < config.status.currentLowBelowMa) status = L.lowConsumption;
  else status = L.charging;

  return { status, lastSeenAt: latest.created_at, ageMs };
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
