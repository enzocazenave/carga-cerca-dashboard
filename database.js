'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite'); // SQLite nativo de Node (>= 22.13) — sin dependencias nativas que compilar
const config = require('./config');

// Asegura que la carpeta del archivo SQLite exista (ej: ./data)
const dbPath = config.databasePath;
const dbDir = path.dirname(dbPath);
if (dbDir && dbDir !== '.' && !fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

// --- Esquema ---
db.exec(`
  CREATE TABLE IF NOT EXISTS chargers (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    charger_id  TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    location    TEXT,
    description TEXT,
    lat         REAL,
    lng         REAL,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS measurements (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    charger_id       TEXT NOT NULL,
    source_voltage   REAL,
    bus_voltage      REAL,
    shunt_voltage_mv REAL,
    current_ma       REAL,
    power_mw         REAL,
    created_at       TEXT NOT NULL,
    FOREIGN KEY (charger_id) REFERENCES chargers (charger_id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_measurements_charger_time
    ON measurements (charger_id, created_at DESC);

  -- Último estado físico reportado por el dispositivo (NFC + relé).
  -- Una fila por cargador: siempre se pisa con el estado más reciente.
  CREATE TABLE IF NOT EXISTS device_status (
    charger_id  TEXT PRIMARY KEY,
    state       TEXT NOT NULL,
    card_uid    TEXT,
    updated_at  TEXT NOT NULL,
    FOREIGN KEY (charger_id) REFERENCES chargers (charger_id) ON DELETE CASCADE
  );

  -- Solicitud de carga: el cliente toca "Quiero cargar mi auto" en la vista
  -- cliente y queda acá su nombre para que la ESP32 del cargador lo muestre
  -- en pantalla ("Hola, Enzo"). Una fila por cargador (la última pisa a la
  -- anterior); se borra al finalizar la carga o vence sola (ver config.request).
  CREATE TABLE IF NOT EXISTS charge_requests (
    charger_id   TEXT PRIMARY KEY,
    client_name  TEXT NOT NULL,
    requested_at TEXT NOT NULL,
    FOREIGN KEY (charger_id) REFERENCES chargers (charger_id) ON DELETE CASCADE
  );

  -- Usuarios del panel: admin (el equipo de CargaCerca) y anfitrión (dueño
  -- de uno o más cargadores). Los conductores NO tienen cuenta todavía (ver
  -- la tabla drivers). Contraseña con scrypt, ver auth.js.
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name          TEXT NOT NULL,
    role          TEXT NOT NULL CHECK (role IN ('admin', 'anfitrion')),
    password_hash TEXT NOT NULL,
    is_demo       INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL
  );

  -- Sesiones de login. Se guarda el hash del token, no el token: si se
  -- filtra la base, las cookies vigentes no sirven.
  CREATE TABLE IF NOT EXISTS auth_sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
  );

  -- Conductores. No hay login: el id es anónimo y lo genera el navegador
  -- del conductor la primera vez que pide cargar (queda en su localStorage,
  -- ver public/conductor.js). Sirve para que la reputación lo siga aunque
  -- cambie el nombre que muestra.
  CREATE TABLE IF NOT EXISTS drivers (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- Sesiones de carga registradas (ver sessions.js). Se abren y cierran
  -- solas con las mediciones y el estado del ESP32; ended_at es NULL
  -- mientras la carga sigue. El precio se copia al abrir, así el monto de
  -- una carga vieja no cambia si después cambia PRICE_PER_KWH.
  CREATE TABLE IF NOT EXISTS charge_sessions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    charger_id      TEXT NOT NULL,
    driver_id       TEXT,
    driver_name     TEXT,
    card_uid        TEXT,
    started_at      TEXT NOT NULL,
    ended_at        TEXT,
    end_reason      TEXT,
    last_at         TEXT NOT NULL,
    last_current_ma REAL,
    last_power_mw   REAL,
    below_since     TEXT,
    energy_wh       REAL NOT NULL DEFAULT 0,
    peak_power_mw   REAL,
    energy_scale    REAL NOT NULL DEFAULT 1,
    price_per_kwh   REAL NOT NULL DEFAULT 0,
    commission_rate REAL NOT NULL DEFAULT 0,
    currency        TEXT,
    FOREIGN KEY (charger_id) REFERENCES chargers (charger_id) ON DELETE CASCADE,
    FOREIGN KEY (driver_id) REFERENCES drivers (id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_charger_time
    ON charge_sessions (charger_id, started_at DESC);

  -- Como mucho una sesión abierta por cargador.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_one_open
    ON charge_sessions (charger_id) WHERE ended_at IS NULL;

  -- Reseña del anfitrión al conductor, una por carga. No cuelga en cascada
  -- de la sesión: si se borra un cargador (y con él su historial), las
  -- reseñas siguen contando para la reputación del conductor.
  CREATE TABLE IF NOT EXISTS driver_reviews (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id   INTEGER UNIQUE,
    driver_id    TEXT NOT NULL,
    charger_id   TEXT,
    rating       INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
    comment      TEXT,
    created_at   TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES charge_sessions (id) ON DELETE SET NULL,
    FOREIGN KEY (driver_id) REFERENCES drivers (id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_reviews_driver ON driver_reviews (driver_id);

  -- Interesados que dejan sus datos en la landing (/): conductores que
  -- quieren usar la app y anfitriones (particulares, consorcios, comercios)
  -- que quieren sumar su cargador. Son datos personales (Ley 25.326): solo
  -- los lee el admin, en /admin/interesados.
  CREATE TABLE IF NOT EXISTS leads (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    kind       TEXT NOT NULL,
    name       TEXT NOT NULL,
    contact    TEXT NOT NULL,
    zone       TEXT,
    created_at TEXT NOT NULL
  );
`);

// --- Migraciones ---
// CREATE TABLE IF NOT EXISTS no agrega columnas a una tabla que ya existe
// (ej: en Railway, sobre datos previos). lat/lng se sumaron después, así
// que los agregamos a mano si hace falta; SQLite no soporta
// "ADD COLUMN IF NOT EXISTS", por eso el try/catch.
function agregarColumnaSiFalta(tabla, columna, tipo) {
  try {
    db.exec(`ALTER TABLE ${tabla} ADD COLUMN ${columna} ${tipo}`);
  } catch (err) {
    if (!/duplicate column/i.test(err.message)) throw err;
  }
}

agregarColumnaSiFalta('chargers', 'lat', 'REAL');
agregarColumnaSiFalta('chargers', 'lng', 'REAL');
agregarColumnaSiFalta('charge_requests', 'driver_id', 'TEXT');
// Dueño del cargador (anfitrión) y su precio por kWh (null = el general).
agregarColumnaSiFalta('chargers', 'owner_id', 'INTEGER REFERENCES users (id) ON DELETE SET NULL');
agregarColumnaSiFalta('chargers', 'price_per_kwh', 'REAL');
agregarColumnaSiFalta('charge_sessions', 'commission_rate', 'REAL NOT NULL DEFAULT 0');

console.log(`[db] SQLite listo en ${path.resolve(dbPath)}`);

module.exports = db;
