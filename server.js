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
};

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
  const status = computeStatus(latest);
  const recentDesc = q.recentMeasurements.all(chargerId, config.measurements.defaultLimit);
  const recentAsc = recentDesc.slice().reverse();
  const session = computeCurrentSession(recentAsc);
  return {
    ...status,
    latest: latest ? measurementToPublic(latest) : null,
    session,
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
// Vistas HTML
// ------------------------------------------------------------------
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/chargers/:chargerId', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'charger.html'))
);

// ------------------------------------------------------------------
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Error interno del servidor' });
});

app.listen(config.port, config.host, () => {
  console.log(`[server] CargaCerca escuchando en http://${config.host}:${config.port}`);
});
