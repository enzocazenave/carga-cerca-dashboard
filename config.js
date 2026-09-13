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
      // Estados que reporta un ESP32 con lector NFC + relé (ver deviceStates abajo)
      waitingCard: 'Esperando tarjeta',
      waitingStart: 'Tarjeta leída · esperando inicio',
      finished: 'Carga finalizada',
    },
  },

  // --- Estado físico del dispositivo (ESP32 con NFC + relé) ---
  // Estados válidos que puede reportar POST /api/chargers/:chargerId/device-state.
  // Un ESP32 simple (sin NFC/relé) nunca manda esto y el estado se sigue
  // infiriendo solo por corriente (ver computeStatus en status.js).
  deviceStates: ['esperando_tarjeta', 'esperando_inicio', 'cargando', 'finalizada'],

  // --- Solicitud de carga (el cliente pide cargar desde la app) ---
  // Vive un tiempo acotado: si nadie se acerca a apoyar la tarjeta, se
  // considera vencida y la ESP32/vista cliente dejan de mostrar el nombre.
  request: {
    expireAfterMs: 3 * 60 * 1000, // 3 minutos para acercarse y apoyar la tarjeta
    maxNameLength: 40,
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

  // --- Vista cliente (estimaciones amigables, no técnicas) ---
  client: {
    // Precio de la energía. Si es 0 no se muestra el costo estimado.
    pricePerKwh: Number(process.env.PRICE_PER_KWH) || 76,
    currency: process.env.PRICE_CURRENCY || 'ARS',
    // Autonomía aproximada de un auto eléctrico por kWh (para el "≈ X km cargados").
    kmPerKwh: Number(process.env.KM_PER_KWH) || 7,
    // Radio (metros) dentro del cual el mapa deja pedir "Quiero cargar" sin
    // avisar que hay que acercarse. Si el navegador no da ubicación, no
    // bloqueamos: mejor dejar pedir de más que trabar el flujo por GPS.
    maxRequestDistanceM: Number(process.env.MAX_REQUEST_DISTANCE_M) || 150,
  },
};

module.exports = config;
