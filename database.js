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

console.log(`[db] SQLite listo en ${path.resolve(dbPath)}`);

module.exports = db;
