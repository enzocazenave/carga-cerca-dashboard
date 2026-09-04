'use strict';

/**
 * Simulador de un ESP32 para validar el prototipo sin hardware.
 *
 *   node simulate.js CC-001 [baseUrl]
 *
 * Crea el cargador si no existe y envía una medición cada 5 segundos,
 * alternando entre "en carga" y "sin carga" para ver cambiar el estado
 * y la sesión en el dashboard.
 */

const chargerId = process.argv[2] || 'CC-001';
const baseUrl = (process.argv[3] || process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');

async function ensureCharger() {
  const res = await fetch(`${baseUrl}/api/chargers/${encodeURIComponent(chargerId)}`);
  if (res.ok) return;
  await fetch(`${baseUrl}/api/chargers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chargerId,
      name: `Simulado ${chargerId}`,
      location: 'Simulador',
      description: 'Generado por simulate.js',
    }),
  });
  console.log(`Cargador ${chargerId} creado.`);
}

let t = 0;
async function tick() {
  t += 1;
  // ~40s cargando, ~20s en reposo
  const charging = t % 6 < 4;
  const busVoltage = 5.0 + Math.random() * 0.2;
  const currentMa = charging ? 1200 + Math.random() * 600 : Math.random() * 20;
  const shuntVoltageMv = currentMa * 0.1;
  const sourceVoltage = busVoltage + shuntVoltageMv / 1000;
  const powerMw = busVoltage * currentMa;

  try {
    const res = await fetch(`${baseUrl}/api/measurements`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chargerId,
        sourceVoltage: +sourceVoltage.toFixed(2),
        busVoltage: +busVoltage.toFixed(2),
        shuntVoltageMv: +shuntVoltageMv.toFixed(2),
        currentMa: +currentMa.toFixed(2),
        powerMw: +powerMw.toFixed(2),
      }),
    });
    console.log(`[${new Date().toLocaleTimeString()}] ${res.status} · ${currentMa.toFixed(0)} mA · ${(powerMw / 1000).toFixed(2)} W`);
  } catch (e) {
    console.error('Error enviando:', e.message);
  }
}

(async () => {
  await ensureCharger();
  await tick();
  setInterval(tick, 5000);
})();
