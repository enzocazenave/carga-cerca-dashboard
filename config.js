'use strict';

// Variables de .env en local (ADMIN_EMAIL, ADMIN_PASSWORD, etc). Viene con
// Node, sin dotenv. Si no hay .env (Railway define todo en el entorno) se
// sigue igual; y una variable que ya está en el entorno no se pisa.
try {
  process.loadEnvFile();
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
}

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
    // Sesiones más cortas que esto se descartan al cerrar (picos de corriente,
    // no cargas reales) y no quedan en el historial.
    minDurationMs: 5 * 1000,
  },

  // --- Login del panel (admin y anfitriones) ---
  auth: {
    sessionDays: 30,
    // Botones "Entrar como admin demo / anfitrión demo" en /login, sin
    // contraseña. Prendidos por defecto en local; en Railway hay que pedirlos
    // a propósito con DEMO_LOGIN=1 (el admin demo ve los datos de la landing).
    demoLogin: process.env.DEMO_LOGIN
      ? process.env.DEMO_LOGIN === '1'
      : !process.env.RAILWAY_ENVIRONMENT,
    // Admin real, se crea (o se le actualiza la contraseña) al arrancar.
    adminEmail: process.env.ADMIN_EMAIL || null,
    adminPassword: process.env.ADMIN_PASSWORD || null,
    // Intentos de login fallidos por IP antes de frenar un rato.
    maxFailedLogins: 10,
    failedLoginWindowMs: 10 * 60 * 1000,
  },

  // --- Modelo de negocio (plan de negocios, sección 5) ---
  business: {
    // Comisión de CargaCerca sobre cada carga. El resto es del anfitrión.
    commissionRate: process.env.COMMISSION_RATE !== undefined ? Number(process.env.COMMISSION_RATE) : 0.15,
    // Argentina no tiene horario de verano: los totales "por día" se cortan
    // a medianoche de UTC-3.
    dayOffset: '-3 hours',
  },

  // --- Reseñas del anfitrión al conductor ---
  reviews: {
    maxCommentLength: 280,
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
    // Escala de demo: el prototipo mide cargas chicas (~12 W, no un auto),
    // así que la energía se multiplica por este factor antes de mostrarla y
    // cobrarla, para que los montos se parezcan a una carga real. Lo usan la
    // vista cliente y el registro de sesiones (el panel muestra las dos
    // cifras). Con un medidor real conectado a un auto, poner 1.
    energyScale: Number(process.env.DEMO_ENERGY_SCALE) || 1000,
    // Autonomía aproximada de un auto eléctrico por kWh (para el "≈ X km cargados").
    kmPerKwh: Number(process.env.KM_PER_KWH) || 7,
    // Radio (metros) dentro del cual el mapa deja pedir "Quiero cargar" sin
    // avisar que hay que acercarse. Si el navegador no da ubicación, no
    // bloqueamos: mejor dejar pedir de más que trabar el flujo por GPS.
    maxRequestDistanceM: Number(process.env.MAX_REQUEST_DISTANCE_M) || 150,
  },
};

module.exports = config;
