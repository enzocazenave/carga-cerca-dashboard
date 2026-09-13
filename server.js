'use strict';

const path = require('path');
const express = require('express');

const config = require('./config');
const db = require('./database');
const { computeStatus, computeCurrentSession } = require('./status');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ------------------------------------------------------------------
// Helpers de acceso a datos
// ------------------------------------------------------------------
const nowIso = () => new Date().toISOString();

const q = {
  listChargers: db.prepare('SELECT * FROM chargers ORDER BY created_at DESC'),
  getCharger: db.prepare('SELECT * FROM chargers WHERE charger_id = ?'),
  insertCharger: db.prepare(`
    INSERT INTO chargers (charger_id, name, location, description, created_at, updated_at)
    VALUES (@charger_id, @name, @location, @description, @created_at, @updated_at)
  `),
  updateCharger: db.prepare(`
    UPDATE chargers
       SET name = @name, location = @location, description = @description, updated_at = @updated_at
     WHERE charger_id = @charger_id
  `),
  deleteCharger: db.prepare('DELETE FROM chargers WHERE charger_id = ?'),

  insertMeasurement: db.prepare(`
    INSERT INTO measurements
      (charger_id, source_voltage, bus_voltage, shunt_voltage_mv, current_ma, power_mw, created_at)
    VALUES
      (@charger_id, @source_voltage, @bus_voltage, @shunt_voltage_mv, @current_ma, @power_mw, @created_at)
  `),
  latestMeasurement: db.prepare(
    'SELECT * FROM measurements WHERE charger_id = ? ORDER BY created_at DESC, id DESC LIMIT 1'
  ),
  recentMeasurements: db.prepare(
    'SELECT * FROM measurements WHERE charger_id = ? ORDER BY created_at DESC, id DESC LIMIT ?'
  ),

  getDeviceState: db.prepare('SELECT * FROM device_status WHERE charger_id = ?'),
  upsertDeviceState: db.prepare(`
    INSERT INTO device_status (charger_id, state, card_uid, updated_at)
    VALUES (@charger_id, @state, @card_uid, @updated_at)
    ON CONFLICT(charger_id) DO UPDATE SET
      state = excluded.state,
      card_uid = excluded.card_uid,
      updated_at = excluded.updated_at
  `),

  getChargeRequest: db.prepare('SELECT * FROM charge_requests WHERE charger_id = ?'),
  upsertChargeRequest: db.prepare(`
    INSERT INTO charge_requests (charger_id, client_name, requested_at)
    VALUES (@charger_id, @client_name, @requested_at)
    ON CONFLICT(charger_id) DO UPDATE SET
      client_name = excluded.client_name,
      requested_at = excluded.requested_at
  `),
  deleteChargeRequest: db.prepare('DELETE FROM charge_requests WHERE charger_id = ?'),
};

/** Solicitud de carga vigente para un cargador (o null si no hay o venció). */
function pendingRequestFor(chargerId, now = Date.now()) {
  const row = q.getChargeRequest.get(chargerId);
  if (!row) return null;
  if (now - Date.parse(row.requested_at) > config.request.expireAfterMs) return null;
  return { name: row.client_name, requestedAt: row.requested_at };
}

function chargerToPublic(row) {
  return {
    id: row.id,
    chargerId: row.charger_id,
    name: row.name,
    location: row.location,
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function measurementToPublic(row) {
  return {
    id: row.id,
    chargerId: row.charger_id,
    sourceVoltage: row.source_voltage,
    busVoltage: row.bus_voltage,
    shuntVoltageMv: row.shunt_voltage_mv,
    currentMa: row.current_ma,
    powerMw: row.power_mw,
    createdAt: row.created_at,
  };
}

/** Info derivada (estado + sesión) de un cargador. */
function chargerRuntime(chargerId) {
  const latest = q.latestMeasurement.get(chargerId);
  const deviceState = q.getDeviceState.get(chargerId);
  const status = computeStatus(latest, deviceState);
  const recentDesc = q.recentMeasurements.all(chargerId, config.measurements.defaultLimit);
  const recentAsc = recentDesc.slice().reverse();
  const session = computeCurrentSession(recentAsc);
  return {
    ...status,
    latest: latest ? measurementToPublic(latest) : null,
    session,
    pendingRequest: pendingRequestFor(chargerId),
  };
}

// ------------------------------------------------------------------
// Healthcheck (Railway)
// ------------------------------------------------------------------
app.get('/health', (_req, res) => res.json({ ok: true }));

// ------------------------------------------------------------------
// API - CRUD cargadores
// ------------------------------------------------------------------
app.get('/api/chargers', (_req, res) => {
  const rows = q.listChargers.all();
  const data = rows.map((row) => ({
    ...chargerToPublic(row),
    ...chargerRuntime(row.charger_id),
  }));
  res.json(data);
});

app.get('/api/chargers/:chargerId', (req, res) => {
  const row = q.getCharger.get(req.params.chargerId);
  if (!row) return res.status(404).json({ error: 'Cargador no encontrado' });
  res.json({ ...chargerToPublic(row), ...chargerRuntime(row.charger_id) });
});

app.post('/api/chargers', (req, res) => {
  const { chargerId, name, location, description } = req.body || {};
  if (!chargerId || !String(chargerId).trim()) {
    return res.status(400).json({ error: 'chargerId es obligatorio' });
  }
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'name es obligatorio' });
  }
  if (q.getCharger.get(chargerId)) {
    return res.status(409).json({ error: `Ya existe un cargador con chargerId "${chargerId}"` });
  }

  const ts = nowIso();
  q.insertCharger.run({
    charger_id: String(chargerId).trim(),
    name: String(name).trim(),
    location: location ? String(location).trim() : null,
    description: description ? String(description).trim() : null,
    created_at: ts,
    updated_at: ts,
  });
  res.status(201).json(chargerToPublic(q.getCharger.get(chargerId)));
});

app.put('/api/chargers/:chargerId', (req, res) => {
  const existing = q.getCharger.get(req.params.chargerId);
  if (!existing) return res.status(404).json({ error: 'Cargador no encontrado' });

  const { name, location, description } = req.body || {};
  if (name !== undefined && !String(name).trim()) {
    return res.status(400).json({ error: 'name no puede quedar vacío' });
  }

  q.updateCharger.run({
    charger_id: existing.charger_id,
    name: name !== undefined ? String(name).trim() : existing.name,
    location: location !== undefined ? (location ? String(location).trim() : null) : existing.location,
    description:
      description !== undefined ? (description ? String(description).trim() : null) : existing.description,
    updated_at: nowIso(),
  });
  res.json(chargerToPublic(q.getCharger.get(existing.charger_id)));
});

app.delete('/api/chargers/:chargerId', (req, res) => {
  const existing = q.getCharger.get(req.params.chargerId);
  if (!existing) return res.status(404).json({ error: 'Cargador no encontrado' });
  q.deleteCharger.run(existing.charger_id);
  res.json({ ok: true });
});

// ------------------------------------------------------------------
// API - Mediciones
// ------------------------------------------------------------------
app.post('/api/measurements', (req, res) => {
  const { chargerId, sourceVoltage, busVoltage, shuntVoltageMv, currentMa, powerMw } = req.body || {};

  if (!chargerId) {
    return res.status(400).json({ error: 'chargerId es obligatorio' });
  }
  if (!q.getCharger.get(chargerId)) {
    return res
      .status(404)
      .json({ error: `El cargador "${chargerId}" no existe. Crealo antes de enviar mediciones.` });
  }

  const num = (v) => (v === undefined || v === null || v === '' ? null : Number(v));

  q.insertMeasurement.run({
    charger_id: String(chargerId),
    source_voltage: num(sourceVoltage),
    bus_voltage: num(busVoltage),
    shunt_voltage_mv: num(shuntVoltageMv),
    current_ma: num(currentMa),
    power_mw: num(powerMw),
    created_at: nowIso(),
  });

  res.status(201).json({ ok: true });
});

app.get('/api/chargers/:chargerId/measurements', (req, res) => {
  if (!q.getCharger.get(req.params.chargerId)) {
    return res.status(404).json({ error: 'Cargador no encontrado' });
  }
  let limit = parseInt(req.query.limit, 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = config.measurements.defaultLimit;
  limit = Math.min(limit, config.measurements.maxLimit);

  const rows = q.recentMeasurements.all(req.params.chargerId, limit);
  // Devolvemos en orden cronológico ascendente (cómodo para graficar)
  res.json(rows.reverse().map(measurementToPublic));
});

app.get('/api/chargers/:chargerId/latest', (req, res) => {
  if (!q.getCharger.get(req.params.chargerId)) {
    return res.status(404).json({ error: 'Cargador no encontrado' });
  }
  const latest = q.latestMeasurement.get(req.params.chargerId);
  const runtime = chargerRuntime(req.params.chargerId);
  res.json({
    latest: latest ? measurementToPublic(latest) : null,
    status: runtime.status,
    lastSeenAt: runtime.lastSeenAt,
    ageMs: runtime.ageMs,
    session: runtime.session,
  });
});

// ------------------------------------------------------------------
// API - Estado físico del dispositivo (ESP32 con NFC + relé)
// ------------------------------------------------------------------
// Un ESP32 "kiosco" (pantalla + lector NFC + relé) reporta acá cada
// transición de su máquina de estados. Es opcional: un ESP32 simple
// (solo INA219) no la usa y el estado se sigue infiriendo por corriente.
app.post('/api/chargers/:chargerId/device-state', (req, res) => {
  const charger = q.getCharger.get(req.params.chargerId);
  if (!charger) {
    return res
      .status(404)
      .json({ error: `El cargador "${req.params.chargerId}" no existe. Crealo antes de reportar estado.` });
  }

  const { state, cardUid } = req.body || {};
  if (!config.deviceStates.includes(state)) {
    return res.status(400).json({ error: `state inválido. Usar uno de: ${config.deviceStates.join(', ')}` });
  }

  q.upsertDeviceState.run({
    charger_id: charger.charger_id,
    state,
    card_uid: cardUid ? String(cardUid).trim() : null,
    updated_at: nowIso(),
  });

  // La carga terminó: borramos la solicitud pendiente para que la pantalla
  // del cargador y la vista cliente dejen de mostrar el nombre del cliente
  // anterior y quede libre para el que sigue.
  if (state === 'finalizada') {
    q.deleteChargeRequest.run(charger.charger_id);
  }

  res.status(201).json({ ok: true });
});

// ------------------------------------------------------------------
// API - Solicitud de carga ("Quiero cargar mi auto" desde la app cliente)
// ------------------------------------------------------------------
// El cliente pide cargar en un cargador puntual mandando su nombre. La
// ESP32 del cargador consulta este mismo endpoint (GET) mientras espera
// tarjeta, para saludar por nombre en la pantalla física.
app.post('/api/chargers/:chargerId/request', (req, res) => {
  const charger = q.getCharger.get(req.params.chargerId);
  if (!charger) {
    return res.status(404).json({ error: `El cargador "${req.params.chargerId}" no existe.` });
  }

  const { name } = req.body || {};
  const clean = String(name || '')
    .trim()
    .replace(/["\\]/g, '') // fuera comillas/backslashes: la ESP32 parsea el JSON a mano
    .slice(0, config.request.maxNameLength);

  if (!clean) {
    return res.status(400).json({ error: 'name es obligatorio' });
  }

  q.upsertChargeRequest.run({
    charger_id: charger.charger_id,
    client_name: clean,
    requested_at: nowIso(),
  });

  res.status(201).json({ ok: true, name: clean });
});

app.get('/api/chargers/:chargerId/request', (req, res) => {
  const charger = q.getCharger.get(req.params.chargerId);
  if (!charger) {
    return res.status(404).json({ error: `El cargador "${req.params.chargerId}" no existe.` });
  }
  const pending = pendingRequestFor(charger.charger_id);
  res.json(pending || { name: null, requestedAt: null });
});

// ------------------------------------------------------------------
// Config pública (para la vista cliente)
// ------------------------------------------------------------------
app.get('/api/config', (_req, res) => {
  res.json({
    pricePerKwh: config.client.pricePerKwh,
    currency: config.client.currency,
    kmPerKwh: config.client.kmPerKwh,
  });
});

// ------------------------------------------------------------------
// Vistas HTML
// ------------------------------------------------------------------
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/chargers/:chargerId', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'charger.html'))
);
// Vista cliente (mobile, no técnica)
app.get('/c/:chargerId', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'cliente.html'))
);

// ------------------------------------------------------------------
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Error interno del servidor' });
});

app.listen(config.port, config.host, () => {
  console.log(`[server] CargaCerca escuchando en http://${config.host}:${config.port}`);
});
