'use strict';

const $ = (id) => document.getElementById(id);
const NAME_KEY = 'cc_client_name';
const getMyName = () => (localStorage.getItem(NAME_KEY) || '').trim() || null;

// Mismo criterio "amigable" que la vista cliente (ver public/cliente.js),
// pero acá solo necesitamos ícono + color, no toda la copy larga.
const VIEW = {
  'Cargando': { icon: '⚡', color: 'var(--green)', label: 'Cargando' },
  'Consumo bajo': { icon: '🔋', color: 'var(--amber)', label: 'Carga lenta' },
  'Disponible': { icon: '🔌', color: 'var(--blue)', label: 'Disponible' },
  'Esperando tarjeta': { icon: '🔌', color: 'var(--blue)', label: 'Disponible' },
  'Tarjeta leída · esperando inicio': { icon: '👉', color: 'var(--amber)', label: 'Alguien está por cargar' },
  'Carga finalizada': { icon: '✅', color: 'var(--blue)', label: 'Disponible' },
  'Desconectado': { icon: '⚠️', color: 'var(--red)', label: 'Sin conexión' },
  'Nunca conectado': { icon: '🔌', color: 'var(--gray)', label: 'Sin datos aún' },
};

let cfg = { maxRequestDistanceM: 150 };
let miPos = null; // { lat, lng }
let vistaCentrada = false;
let chargerIdResaltado = null;

// ---- Mapa ----
const map = L.map('map', { zoomControl: false, attributionControl: false });
map.setView([-34.6037, -58.3816], 13); // Buenos Aires, hasta tener datos reales

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
}).addTo(map);

L.control.attribution({ position: 'bottomleft', prefix: false }).addAttribution('© OpenStreetMap').addTo(map);
L.control.zoom({ position: 'bottomright' }).addTo(map);

const capaCargadores = L.layerGroup().addTo(map);
let marcadorYo = null;

function distanciaMetros(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function fmtDistancia(m) {
  if (m == null) return '';
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(1)} km`;
}

function pinIcon(color, icon) {
  return L.divIcon({
    className: '',
    html: `<div class="cc-pin" style="background:${color}"><span>${icon}</span></div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 29],
    popupAnchor: [0, -28],
  });
}

const meIcon = L.divIcon({ className: '', html: '<div class="cc-me"></div>', iconSize: [18, 18], iconAnchor: [9, 9] });

async function api(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

async function pedirCarga(charger, btn) {
  let name = getMyName();
  if (!name) {
    name = (prompt('¿Cómo te llamás? Así te saludamos en el cargador.') || '').trim();
    if (!name) return;
    localStorage.setItem(NAME_KEY, name);
  }

  btn.disabled = true;
  btn.textContent = 'Enviando…';
  try {
    await api(`/api/chargers/${encodeURIComponent(charger.chargerId)}/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    location.href = `/c/${encodeURIComponent(charger.chargerId)}`;
  } catch (e) {
    alert(e.message);
    btn.disabled = false;
    btn.textContent = '🚗 Quiero cargar';
  }
}

function renderBanner(estadoUbicacion) {
  const banner = $('banner');
  if (estadoUbicacion === 'denegada') {
    banner.innerHTML = `<span>Activá la ubicación para ver qué tan cerca estás</span><button id="bReintentar">Reintentar</button>`;
    banner.querySelector('#bReintentar').addEventListener('click', pedirUbicacion);
  } else if (estadoUbicacion === 'sin-soporte') {
    banner.innerHTML = `<span>Tu navegador no puede compartir tu ubicación</span>`;
  } else {
    banner.innerHTML = '';
  }
}

function renderLista(chargers) {
  const myName = getMyName();

  const conDatos = chargers.map((c) => {
    const dist =
      miPos && c.lat != null && c.lng != null
        ? distanciaMetros(miPos.lat, miPos.lng, c.lat, c.lng)
        : null;
    return { c, dist };
  });

  conDatos.sort((a, b) => {
    if (a.dist == null && b.dist == null) return a.c.name.localeCompare(b.c.name);
    if (a.dist == null) return 1;
    if (b.dist == null) return -1;
    return a.dist - b.dist;
  });

  if (conDatos.length === 0) {
    $('list').innerHTML = '<div class="empty-list">Todavía no hay cargadores cargados en el sistema.</div>';
    return;
  }

  $('list').innerHTML = conDatos
    .map(({ c, dist }) => {
      const v = VIEW[c.status] || VIEW['Nunca conectado'];
      const busy = c.status === 'Cargando';
      const pr = c.pendingRequest;
      const lejos = dist != null && dist > cfg.maxRequestDistanceM;

      let statusHtml = `<b style="color:${v.color}">${v.label}</b>`;
      let btnHtml;

      if (busy) {
        btnHtml = `<button class="row-btn" disabled>Ocupado</button>`;
      } else if (pr && pr.name) {
        if (myName && pr.name === myName) {
          statusHtml = `<b style="color:var(--green)">Tu solicitud está activa</b>`;
          btnHtml = `<button class="row-btn ghost" data-goto="${esc(c.chargerId)}">Ver →</button>`;
        } else {
          statusHtml = `<b style="color:var(--muted)">Reservado</b>`;
          btnHtml = `<button class="row-btn" disabled>Reservado</button>`;
        }
      } else if (lejos) {
        btnHtml = `<button class="row-btn" disabled>Acercate</button>`;
      } else {
        btnHtml = `<button class="row-btn" data-pedir="${esc(c.chargerId)}">🚗 Quiero cargar</button>`;
      }

      return `
        <div class="charger-row ${c.chargerId === chargerIdResaltado ? 'highlight' : ''}" data-row="${esc(c.chargerId)}">
          <div class="row-icon" style="background:${v.color}22">${v.icon}</div>
          <div class="row-main">
            <div class="row-name">${esc(c.name)}</div>
            <div class="row-status">${statusHtml}</div>
          </div>
          <div class="row-side">
            <div class="row-dist">${dist != null ? fmtDistancia(dist) : (c.lat != null ? '' : 'Sin ubicación')}</div>
            ${btnHtml}
          </div>
        </div>`;
    })
    .join('');

  $('list').querySelectorAll('[data-pedir]').forEach((btn) => {
    const charger = conDatos.find((x) => x.c.chargerId === btn.dataset.pedir).c;
    btn.addEventListener('click', () => pedirCarga(charger, btn));
  });
  $('list').querySelectorAll('[data-goto]').forEach((btn) => {
    btn.addEventListener('click', () => (location.href = `/c/${encodeURIComponent(btn.dataset.goto)}`));
  });
  $('list').querySelectorAll('[data-row]').forEach((row) => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      const c = conDatos.find((x) => x.c.chargerId === row.dataset.row)?.c;
      if (c && c.lat != null && c.lng != null) {
        map.flyTo([c.lat, c.lng], Math.max(map.getZoom(), 16), { duration: 0.5 });
      }
    });
  });
}

function renderMapa(chargers) {
  capaCargadores.clearLayers();

  const conCoords = chargers.filter((c) => c.lat != null && c.lng != null);

  conCoords.forEach((c) => {
    const v = VIEW[c.status] || VIEW['Nunca conectado'];
    const marker = L.marker([c.lat, c.lng], { icon: pinIcon(v.color, v.icon) }).addTo(capaCargadores);
    marker.bindPopup(
      `<div class="popup-name">${esc(c.name)}</div><div class="popup-status">${esc(v.label)}</div>`
    );
    marker.on('click', () => {
      chargerIdResaltado = c.chargerId;
      const row = document.querySelector(`[data-row="${cssEsc(c.chargerId)}"]`);
      if (row) row.scrollIntoView({ behavior: 'smooth', block: 'center' });
      renderLista(ultimosChargers);
      setTimeout(() => {
        chargerIdResaltado = null;
      }, 2000);
    });
  });

  if (!vistaCentrada) {
    const puntos = conCoords.map((c) => [c.lat, c.lng]);
    if (miPos) puntos.push([miPos.lat, miPos.lng]);
    if (puntos.length > 1) {
      map.fitBounds(puntos, { padding: [40, 40], maxZoom: 16 });
      vistaCentrada = true;
    } else if (puntos.length === 1) {
      map.setView(puntos[0], 15);
      vistaCentrada = true;
    }
  }
}

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function cssEsc(v) {
  return String(v).replace(/"/g, '\\"');
}

let ultimosChargers = [];

function actualizarSheetHead() {
  const conCoords = ultimosChargers.filter((c) => c.lat != null && c.lng != null).length;
  $('sheetTitle').textContent = miPos ? 'Cargadores cerca tuyo' : 'Cargadores';
  $('sheetSub').textContent = miPos
    ? `${conCoords} en el mapa · ordenados por distancia`
    : 'Activá tu ubicación para ordenarlos por distancia';
}

async function refresh() {
  try {
    ultimosChargers = await api('/api/chargers');
  } catch {
    $('sheetSub').textContent = 'No se pudo conectar con el servidor';
    return;
  }
  renderMapa(ultimosChargers);
  renderLista(ultimosChargers);
  actualizarSheetHead();
  ultimoRenderPesadoMs = Date.now();
}

// ---- Geolocalización ----
// watchPosition puede disparar varias veces por segundo (mejora de precisión,
// movimiento). Mover el marcador "yo" en cada tick es barato, pero
// renderLista()/renderMapa() reconstruyen el DOM entero (innerHTML): si eso
// pasa justo cuando el usuario toca "Quiero cargar", el botón se reemplaza
// bajo el dedo y el tap se pierde. Por eso el re-render pesado va aparte y
// limitado en frecuencia; solo la primera posición fuerza un render inmediato.
let ultimoRenderPesadoMs = 0;
const MIN_INTERVALO_RENDER_PESADO_MS = 3000;

function pedirUbicacion() {
  if (!navigator.geolocation) {
    renderBanner('sin-soporte');
    return;
  }

  $('locateBtn').classList.add('active');

  navigator.geolocation.watchPosition(
    (pos) => {
      const esPrimeraVez = !miPos;
      miPos = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      renderBanner(null);

      if (!marcadorYo) {
        marcadorYo = L.marker([miPos.lat, miPos.lng], { icon: meIcon, zIndexOffset: 1000 }).addTo(map);
      } else {
        marcadorYo.setLatLng([miPos.lat, miPos.lng]);
      }

      const ahora = Date.now();
      if (esPrimeraVez || ahora - ultimoRenderPesadoMs >= MIN_INTERVALO_RENDER_PESADO_MS) {
        ultimoRenderPesadoMs = ahora;
        renderMapa(ultimosChargers);
        renderLista(ultimosChargers);
        actualizarSheetHead();
      }
    },
    (err) => {
      $('locateBtn').classList.remove('active');
      if (err.code === err.PERMISSION_DENIED) renderBanner('denegada');
    },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 }
  );
}

$('locateBtn').addEventListener('click', () => {
  if (miPos) {
    map.flyTo([miPos.lat, miPos.lng], 16, { duration: 0.6 });
  } else {
    pedirUbicacion();
  }
});

(async () => {
  try {
    cfg = { ...cfg, ...(await api('/api/config')) };
  } catch {
    /* usa defaults */
  }
  await refresh();
  pedirUbicacion();
  setInterval(refresh, 4000);
})();
