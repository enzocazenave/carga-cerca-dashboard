'use strict';

const path = require('path');
const express = require('express');

const config = require('./config');
const db = require('./database');
const { computeStatus } = require('./status');
const sessions = require('./sessions');
const drivers = require('./drivers');
const auth = require('./auth');

const app = express();
// Railway pone un proxy HTTPS adelante: así req.secure / req.ip son los reales.
app.set('trust proxy', 1);
app.use(express.json());
app.use(auth.attachUser);
// Solo assets y páginas públicas. Las páginas con login (panel admin y de
// anfitrión) viven en /views y se sirven por las rutas de abajo.
app.use(express.static(path.join(__dirname, 'public')));

const view = (file) => (_req, res) => res.sendFile(path.join(__dirname, 'views', file));

// ------------------------------------------------------------------
// Helpers de acceso a datos
// ------------------------------------------------------------------
const nowIso = () => new Date().toISOString();

const q = {
  listChargers: db.prepare('SELECT * FROM chargers ORDER BY created_at DESC'),
  getCharger: db.prepare('SELECT * FROM chargers WHERE charger_id = ?'),
  insertCharger: db.prepare(`
    INSERT INTO chargers (charger_id, name, location, description, lat, lng, owner_id, price_per_kwh, created_at, updated_at)
    VALUES (@charger_id, @name, @location, @description, @lat, @lng, @owner_id, @price_per_kwh, @created_at, @updated_at)
  `),
  updateCharger: db.prepare(`
    UPDATE chargers
       SET name = @name, location = @location, description = @description,
           lat = @lat, lng = @lng, owner_id = @owner_id, price_per_kwh = @price_per_kwh,
           updated_at = @updated_at
     WHERE charger_id = @charger_id
  `),
  getUser: db.prepare('SELECT id, name, role FROM users WHERE id = ?'),
  listLeads: db.prepare('SELECT * FROM leads ORDER BY id DESC LIMIT 500'),
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
    INSERT INTO charge_requests (charger_id, client_name, driver_id, requested_at)
    VALUES (@charger_id, @client_name, @driver_id, @requested_at)
    ON CONFLICT(charger_id) DO UPDATE SET
      client_name = excluded.client_name,
      driver_id = excluded.driver_id,
      requested_at = excluded.requested_at
  `),
  deleteChargeRequest: db.prepare('DELETE FROM charge_requests WHERE charger_id = ?'),
};

/** Solicitud de carga vigente (o null si no hay o venció). Uso interno: trae el driverId. */
function activeRequestFor(chargerId, now = Date.now()) {
  const row = q.getChargeRequest.get(chargerId);
  if (!row) return null;
  if (now - Date.parse(row.requested_at) > config.request.expireAfterMs) return null;
  return { name: row.client_name, driverId: row.driver_id, requestedAt: row.requested_at };
}

/**
 * Solicitud vigente para las vistas: con la reputación del conductor (para
 * que el anfitrión sepa quién viene) pero sin su id, que no se expone.
 */
function pendingRequestFor(chargerId) {
  const r = activeRequestFor(chargerId);
  if (!r) return null;
  return {
    name: r.name,
    requestedAt: r.requestedAt,
    reputation: r.driverId ? drivers.reputationOf(r.driverId) : null,
  };
}

function chargerToPublic(row) {
  return {
    id: row.id,
    chargerId: row.charger_id,
    name: row.name,
    location: row.location,
    description: row.description,
    lat: row.lat,
    lng: row.lng,
    // Precio vigente (el del anfitrión o el general): lo ve el conductor en el mapa.
    pricePerKwh: sessions.priceFor(row.charger_id),
    currency: config.client.currency,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Para el panel: además, dueño, precio propio y totales de cargas. */
function chargerToPanel(row) {
  const owner = row.owner_id ? q.getUser.get(row.owner_id) : null;
  return {
    ...chargerToPublic(row),
    ...chargerRuntime(row.charger_id),
    owner: owner ? { id: owner.id, name: owner.name } : null,
    ownPricePerKwh: row.price_per_kwh,
    sessionStats: sessions.statsForCharger(row.charger_id),
  };
}

/** Precio por kWh opcional: número >= 0, o null (= usar el general). */
function priceOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : NaN;
}

/** Valida que ownerId (si viene) sea un anfitrión. Devuelve id, null o NaN. */
function ownerOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  const u = q.getUser.get(Number(v));
  return u && u.role === 'anfitrion' ? u.id : NaN;
}

/** Convierte a número finito o null (para lat/lng: campo opcional). */
function numOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
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
  sessions.closeIfStale(chargerId);
  return {
    ...status,
    latest: latest ? measurementToPublic(latest) : null,
    session: sessions.currentSession(chargerId),
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

// Panel: el admin ve todos los cargadores; el anfitrión, solo los suyos.
app.get('/api/panel/chargers', auth.requireApi(), (req, res) => {
  const rows = q.listChargers.all().filter((row) => auth.canAccessCharger(req.user, row));
  res.json(rows.map(chargerToPanel));
});

app.get('/api/panel/chargers/:chargerId', auth.requireApi(), (req, res) => {
  const row = q.getCharger.get(req.params.chargerId);
  if (!row || !auth.canAccessCharger(req.user, row)) {
    return res.status(404).json({ error: 'Cargador no encontrado' });
  }
  res.json(chargerToPanel(row));
});

app.post('/api/chargers', auth.requireApi('admin'), (req, res) => {
  const { chargerId, name, location, description, lat, lng, ownerId, pricePerKwh } = req.body || {};
  if (!chargerId || !String(chargerId).trim()) {
    return res.status(400).json({ error: 'chargerId es obligatorio' });
  }
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'name es obligatorio' });
  }
  if (q.getCharger.get(chargerId)) {
    return res.status(409).json({ error: `Ya existe un cargador con chargerId "${chargerId}"` });
  }
  const owner = ownerOrNull(ownerId);
  if (Number.isNaN(owner)) return res.status(400).json({ error: 'El dueño tiene que ser un anfitrión' });
  const price = priceOrNull(pricePerKwh);
  if (Number.isNaN(price)) return res.status(400).json({ error: 'Precio por kWh inválido' });

  const ts = nowIso();
  q.insertCharger.run({
    charger_id: String(chargerId).trim(),
    name: String(name).trim(),
    location: location ? String(location).trim() : null,
    description: description ? String(description).trim() : null,
    lat: numOrNull(lat),
    lng: numOrNull(lng),
    owner_id: owner,
    price_per_kwh: price,
    created_at: ts,
    updated_at: ts,
  });
  res.status(201).json(chargerToPublic(q.getCharger.get(chargerId)));
});

// El anfitrión configura sus cargadores; solo el admin cambia el dueño.
app.put('/api/chargers/:chargerId', auth.requireApi(), (req, res) => {
  const existing = q.getCharger.get(req.params.chargerId);
  if (!existing || !auth.canAccessCharger(req.user, existing)) {
    return res.status(404).json({ error: 'Cargador no encontrado' });
  }

  const { name, location, description, lat, lng, ownerId, pricePerKwh } = req.body || {};
  if (name !== undefined && !String(name).trim()) {
    return res.status(400).json({ error: 'name no puede quedar vacío' });
  }
  if (ownerId !== undefined && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Solo el equipo de CargaCerca puede cambiar el dueño' });
  }
  const owner = ownerId !== undefined ? ownerOrNull(ownerId) : existing.owner_id;
  if (Number.isNaN(owner)) return res.status(400).json({ error: 'El dueño tiene que ser un anfitrión' });
  const price = pricePerKwh !== undefined ? priceOrNull(pricePerKwh) : existing.price_per_kwh;
  if (Number.isNaN(price)) return res.status(400).json({ error: 'Precio por kWh inválido' });

  q.updateCharger.run({
    charger_id: existing.charger_id,
    name: name !== undefined ? String(name).trim() : existing.name,
    location: location !== undefined ? (location ? String(location).trim() : null) : existing.location,
    description:
      description !== undefined ? (description ? String(description).trim() : null) : existing.description,
    lat: lat !== undefined ? numOrNull(lat) : existing.lat,
    lng: lng !== undefined ? numOrNull(lng) : existing.lng,
    owner_id: owner,
    price_per_kwh: price,
    updated_at: nowIso(),
  });
  res.json(chargerToPublic(q.getCharger.get(existing.charger_id)));
});

app.delete('/api/chargers/:chargerId', auth.requireApi('admin'), (req, res) => {
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

  const row = {
    charger_id: String(chargerId),
    source_voltage: num(sourceVoltage),
    bus_voltage: num(busVoltage),
    shunt_voltage_mv: num(shuntVoltageMv),
    current_ma: num(currentMa),
    power_mw: num(powerMw),
    created_at: nowIso(),
  };
  q.insertMeasurement.run(row);

  // Cada medición alimenta el registro de la sesión de carga (ver sessions.js)
  sessions.onMeasurement(row.charger_id, row, activeRequestFor(row.charger_id), q.getDeviceState.get(row.charger_id));

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

  // El relé manda: "cargando" abre la sesión y "finalizada" la cierra.
  sessions.onDeviceState(
    charger.charger_id,
    state,
    activeRequestFor(charger.charger_id),
    cardUid ? String(cardUid).trim() : null,
    q.latestMeasurement.get(charger.charger_id)
  );

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

  const { name, driverId } = req.body || {};
  const clean = String(name || '')
    .trim()
    .replace(/["\\]/g, '') // fuera comillas/backslashes: la ESP32 parsea el JSON a mano
    .slice(0, config.request.maxNameLength);

  if (!clean) {
    return res.status(400).json({ error: 'name es obligatorio' });
  }

  // driverId es opcional (una versión vieja de la app cacheada no lo
  // manda): sin él la carga queda registrada pero no suma reputación.
  const validDriver = drivers.isValidId(driverId);
  if (validDriver) drivers.upsert(driverId, clean);

  q.upsertChargeRequest.run({
    charger_id: charger.charger_id,
    client_name: clean,
    driver_id: validDriver ? driverId : null,
    requested_at: nowIso(),
  });

  res.status(201).json({ ok: true, name: clean });
});

app.get('/api/chargers/:chargerId/request', (req, res) => {
  const charger = q.getCharger.get(req.params.chargerId);
  if (!charger) {
    return res.status(404).json({ error: `El cargador "${req.params.chargerId}" no existe.` });
  }
  // Respuesta plana a propósito: la ESP32 la parsea a mano buscando "name".
  const pending = activeRequestFor(charger.charger_id);
  res.json(pending ? { name: pending.name, requestedAt: pending.requestedAt } : { name: null, requestedAt: null });
});

// ------------------------------------------------------------------
// API - Historial de cargas y reseñas a conductores
// ------------------------------------------------------------------
app.get('/api/chargers/:chargerId/sessions', auth.requireApi(), (req, res) => {
  if (!auth.canAccessCharger(req.user, q.getCharger.get(req.params.chargerId))) {
    return res.status(404).json({ error: 'Cargador no encontrado' });
  }
  let limit = parseInt(req.query.limit, 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = 50;
  limit = Math.min(limit, 500);
  res.json({
    stats: sessions.statsForCharger(req.params.chargerId),
    sessions: sessions.listForCharger(req.params.chargerId, limit, drivers.reputationOf),
  });
});

// El anfitrión califica al conductor de una carga terminada (una vez por carga).
app.post('/api/sessions/:sessionId/review', auth.requireApi(), (req, res) => {
  const { rating, comment } = req.body || {};
  const session = sessions.getById(Number(req.params.sessionId));
  if (session && !auth.canAccessCharger(req.user, q.getCharger.get(session.charger_id))) {
    return res.status(404).json({ error: 'La carga no existe' });
  }
  const result = drivers.reviewSession(session, rating, comment);
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.status(201).json({ ok: true });
});

// Perfil del conductor. Solo lo pide el propio conductor, que es el único
// que conoce su id (vive en el localStorage de su navegador).
app.get('/api/drivers/:driverId', (req, res) => {
  const p = drivers.isValidId(req.params.driverId) ? drivers.profile(req.params.driverId) : null;
  if (!p) return res.status(404).json({ error: 'Conductor no encontrado' });
  res.json(p);
});

// ------------------------------------------------------------------
// Interesados (formulario de la landing)
// ------------------------------------------------------------------
const LEAD_KINDS = ['conductor', 'particular', 'consorcio', 'comercio'];
const insertLead = db.prepare(`
  INSERT INTO leads (kind, name, contact, zone, created_at)
  VALUES (@kind, @name, @contact, @zone, @created_at)
`);

app.post('/api/leads', (req, res) => {
  const body = req.body || {};
  // Campo trampa: invisible para personas, los bots lo completan.
  if (body.website) return res.status(201).json({ ok: true });

  const clean = (v, max) => String(v || '').trim().slice(0, max);
  const lead = {
    kind: clean(body.kind, 20),
    name: clean(body.name, 80),
    contact: clean(body.contact, 120),
    zone: clean(body.zone, 80) || null,
    created_at: nowIso(),
  };

  if (!LEAD_KINDS.includes(lead.kind)) {
    return res.status(400).json({ error: 'Elegí si sos conductor o anfitrión' });
  }
  if (!lead.name || !lead.contact) {
    return res.status(400).json({ error: 'Completá tu nombre y un email o WhatsApp' });
  }

  insertLead.run(lead);
  console.log(`[leads] nuevo interesado (${lead.kind}${lead.zone ? `, ${lead.zone}` : ''})`);
  res.status(201).json({ ok: true });
});

app.get('/api/leads', auth.requireApi('admin'), (_req, res) => {
  res.json(
    q.listLeads.all().map((l) => ({ id: l.id, kind: l.kind, name: l.name, contact: l.contact, zone: l.zone, createdAt: l.created_at }))
  );
});

// ------------------------------------------------------------------
// Login y usuarios del panel (ver auth.js)
// ------------------------------------------------------------------
app.get('/api/auth/me', (req, res) => {
  res.json({ user: req.user ? auth.userToPublic(req.user) : null, demoLogin: config.auth.demoLogin });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  const result = auth.checkLogin(req.ip, email, password);
  if (result.error) return res.status(result.status).json({ error: result.error });
  auth.startSession(req, res, result.user);
  res.json({ user: auth.userToPublic(result.user), home: auth.homeFor(result.user) });
});

app.post('/api/auth/demo', (req, res) => {
  if (!config.auth.demoLogin) return res.status(404).json({ error: 'El login demo está apagado' });
  const user = auth.demoUser(req.body && req.body.role);
  if (!user) return res.status(400).json({ error: 'Rol demo inválido' });
  auth.startSession(req, res, user);
  res.json({ user: auth.userToPublic(user), home: auth.homeFor(user) });
});

app.post('/api/auth/logout', (req, res) => {
  auth.endSession(req, res);
  res.json({ ok: true });
});

app.get('/api/users', auth.requireApi('admin'), (_req, res) => res.json(auth.listUsers()));

// El admin da de alta anfitriones (con una contraseña inicial que les pasa).
app.post('/api/users', auth.requireApi('admin'), (req, res) => {
  const { email, name, password } = req.body || {};
  const result = auth.createUser({ email, name, password, role: 'anfitrion' });
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.status(201).json(auth.userToPublic(result.user));
});

// Totales por período: el admin ve toda la red; el anfitrión, lo suyo.
const PERIOD_DAYS = { hoy: 0, '7d': 7, '30d': 30 };
app.get('/api/summary', auth.requireApi(), (req, res) => {
  const period = req.query.period in PERIOD_DAYS ? req.query.period : 'todo';
  let from = null;
  if (period !== 'todo') {
    // Medianoche de hoy en Argentina (UTC-3), menos N días.
    const d = new Date(Date.now() - 3 * 3600000);
    d.setUTCHours(0, 0, 0, 0);
    from = new Date(d.getTime() + 3 * 3600000 - PERIOD_DAYS[period] * 86400000).toISOString();
  }
  const ownerId = req.user.role === 'admin' ? null : req.user.id;
  res.json({ period, from, ...sessions.summary(ownerId, from, drivers.reputationOf) });
});

// ------------------------------------------------------------------
// Config pública (para la vista cliente)
// ------------------------------------------------------------------
app.get('/api/config', (_req, res) => {
  res.json({
    pricePerKwh: config.client.pricePerKwh,
    currency: config.client.currency,
    kmPerKwh: config.client.kmPerKwh,
    maxRequestDistanceM: config.client.maxRequestDistanceM,
  });
});

// ------------------------------------------------------------------
// Vistas HTML
// ------------------------------------------------------------------
// Landing comercial
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
// Login del panel (si ya hay sesión, directo a su inicio)
app.get('/login', (req, res, next) => (req.user ? res.redirect(auth.homeFor(req.user)) : next()), view('login.html'));
// Panel del equipo de CargaCerca
app.get('/admin', auth.requirePage('admin'), view('admin.html'));
app.get('/admin/anfitriones', auth.requirePage('admin'), view('admin-anfitriones.html'));
app.get('/admin/interesados', auth.requirePage('admin'), view('admin-interesados.html'));
app.get('/chargers/:chargerId', auth.requirePage('admin'), view('charger.html'));
// Panel del anfitrión
app.get('/anfitrion', auth.requirePage('anfitrion'), view('anfitrion.html'));
app.get('/anfitrion/cargadores/:chargerId', auth.requirePage('anfitrion'), view('anfitrion-cargador.html'));
// Mapa de cargadores cercanos (mobile, entrada de la app cliente)
app.get('/mapa', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'mapa.html')));
// Vista cliente (mobile, no técnica)
app.get('/c/:chargerId', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'cliente.html'))
);

// ------------------------------------------------------------------
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Error interno del servidor' });
});

auth.seed();

app.listen(config.port, config.host, () => {
  console.log(`[server] CargaCerca escuchando en http://${config.host}:${config.port}`);
});
