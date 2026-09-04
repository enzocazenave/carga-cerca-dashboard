'use strict';

/**
 * Valores centralizados del prototipo.
 * Cambiar acá los umbrales de estado / sesión sin tocar el resto del código.
 */

const config = {
  // --- Servidor ---
  port: process.env.PORT || 3000,
  host: '0.0.0.0',

  // --- Base de datos ---
  // Ruta del archivo SQLite. En Railway conviene apuntar a un Volume:
  //   DATABASE_PATH=/data/cargacerca.sqlite
  databasePath: process.env.DATABASE_PATH || './data/cargacerca.sqlite',

  // --- Estado del cargador (a partir de la última medición) ---
  status: {
    // Si la última medición es más vieja que esto => "Desconectado"
    offlineAfterMs: 20 * 1000,

    // Umbrales de corriente en mA
    currentAvailableBelowMa: 50, // < 50 mA  => "Disponible"
    currentLowBelowMa: 300, // 50–299 mA => "Consumo bajo"
    // >= 300 mA => "Cargando"

    labels: {
      neverConnected: 'Nunca conectado',
      disconnected: 'Desconectado',
      available: 'Disponible',
      lowConsumption: 'Consumo bajo',
      charging: 'Cargando',
    },
  },

  // --- Sesión de carga ---
  session: {
    // Una sesión empieza cuando la corriente pasa de < startThresholdMa a >= startThresholdMa
    startThresholdMa: 50,
    // La sesión termina cuando se mantiene por debajo del umbral este tiempo
    endBelowForMs: 10 * 1000,
  },

  // --- Mediciones ---
  measurements: {
    defaultLimit: 100,
    maxLimit: 1000,
  },
};

module.exports = config;
