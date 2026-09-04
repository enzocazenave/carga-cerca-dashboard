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
`);

console.log(`[db] SQLite listo en ${path.resolve(dbPath)}`);

module.exports = db;
