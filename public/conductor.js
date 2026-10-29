'use strict';

// Identidad del conductor en este navegador, compartida por el mapa y la
// vista de carga. No hay login: el nombre se pide una vez, y el id es un
// identificador anónimo que se genera solo y no cambia aunque cambie el
// nombre. Con ese id el servidor arma la reputación del conductor (las
// reseñas que le dejan los anfitriones). Quien conoce el id "es" ese
// conductor, por eso el servidor nunca lo devuelve en sus respuestas.
const NAME_KEY = 'cc_client_name';
const DRIVER_ID_KEY = 'cc_driver_id';

const getMyName = () => (localStorage.getItem(NAME_KEY) || '').trim() || null;

function getDriverId() {
  let id = localStorage.getItem(DRIVER_ID_KEY);
  if (!id) {
    // randomUUID solo existe en contextos seguros (https o localhost); al
    // probar por IP en la red local usamos un aleatorio equivalente.
    id = crypto.randomUUID
      ? crypto.randomUUID()
      : Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
    localStorage.setItem(DRIVER_ID_KEY, id);
  }
  return id;
}

/** Nombre del conductor, preguntándolo la primera vez. null si cancela. */
function askMyName() {
  let name = getMyName();
  if (!name) {
    name = (prompt('¿Cómo te llamás? Así te saludamos en el cargador.') || '').trim();
    if (!name) return null;
    localStorage.setItem(NAME_KEY, name);
  }
  return name;
}

/** Body para POST /api/chargers/:id/request */
const requestBody = (name) => JSON.stringify({ name, driverId: getDriverId() });

/** "★ 4,8 · 3 reseñas" (o null si todavía no tiene reseñas). */
function fmtReputation(rep) {
  if (!rep || !rep.count) return null;
  const n = rep.rating.toLocaleString('es-AR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return `★ ${n} · ${rep.count} ${rep.count === 1 ? 'reseña' : 'reseñas'}`;
}
