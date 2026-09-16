'use strict';

const $ = (id) => document.getElementById(id);
const NAME_KEY = 'cc_client_name';
const getMyName = () => (localStorage.getItem(NAME_KEY) || '').trim() || null;

// Mismo criterio "amigable" que la vista cliente (ver public/cliente.js),
// pero acá solo necesitamos ícono + color, no toda la copy larga. `icon` es
// el nombre de un ícono de /public/icons.js (CC_ICONS), no un emoji: así se
// ve igual en cualquier navegador/SO y se puede pintar del color del estado.
// Colores en hex literal (no var(--...)): se concatenan con un sufijo de
// alpha más abajo (`${color}22`) para el fondo tenue de los íconos de la
// lista, y eso solo funciona con valores hex reales, no con var().
const VIEW = {
  'Cargando': { icon: 'bolt', color: '#16a34a', label: 'Cargando' },
  'Consumo bajo': { icon: 'batteryLow', color: '#d97706', label: 'Carga lenta' },
  'Disponible': { icon: 'plug', color: '#2563eb', label: 'Disponible' },
  'Esperando tarjeta': { icon: 'plug', color: '#2563eb', label: 'Disponible' },
  'Tarjeta leída · esperando inicio': { icon: 'arrowRightCircle', color: '#d97706', label: 'Alguien está por cargar' },
  'Carga finalizada': { icon: 'checkCircle', color: '#2563eb', label: 'Disponible' },
  'Desconectado': { icon: 'alertTriangle', color: '#ef4444', label: 'Sin conexión' },
  'Nunca conectado': { icon: 'plug', color: '#94a3b8', label: 'Sin datos aún' },
};

let cfg = { maxRequestDistanceM: 150 };
let miPos = null; // { lat, lng }
let vistaCentrada = false;

// Altura "asomada" de la hoja inferior (ver sección de arrastre, más abajo):
// la usamos acá para que fitBounds no centre marcadores justo detrás de la
// hoja, y allá para el snap al soltar. Un solo lugar, sin duplicar el valor.
const SHEET_PEEK_VH = 30;
let chargerIdResaltado = null;

// ---- Mapa ----
const map = L.map('map', { zoomControl: false, attributionControl: false });
map.setView([-34.6037, -58.3816], 13); // Buenos Aires, hasta tener datos reales

// Tiles de Esri (gratis, sin API key). Probamos primero con CARTO pero
// ahora exige key en todos sus estilos (hasta el clásico "light_all" tira
// el watermark "API KEY REQUIRED"), así que usamos el servicio REST clásico
// de ArcGIS Online, que sigue siendo de uso libre.
// Siempre en claro (calles a color, con nombres): toda la app cliente
// (mapa + vista de cargador) queda fija en modo claro a propósito, para
// que combine con la pantalla física del cargador, que también es clara.
L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
  maxZoom: 19,
  maxNativeZoom: 19,
}).addTo(map);

L.control
  .attribution({ position: 'bottomleft', prefix: false })
  .addAttribution('© <a href="https://www.esri.com">Esri</a> © OpenStreetMap contributors')
  .addTo(map);

// Sin control de +/-: en mobile se usa pinch-zoom (como Waze/Google Maps),
// y así el mapa queda más limpio.

const capaCargadores = L.layerGroup().addTo(map);
let marcadorYo = null;
let circuloPrecision = null;

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

// Pin tipo "gota" (el clásico de Google Maps/Waze) dibujado en SVG, con el
// ícono de estado (de CC_ICONS, ver /public/icons.js) adentro del círculo
// blanco, pintado del mismo color que la gota. La sombra y la animación de
// caída van en CSS (.cc-pin-wrap), no acá, para no duplicar filtros SVG
// con el mismo id en cada marcador.
function pinIcon(color, iconName) {
  const glyph = CC_ICONS[iconName] || '';
  const svg = `
    <svg width="38" height="50" viewBox="0 0 38 50" xmlns="http://www.w3.org/2000/svg">
      <path d="M19 0C8.5 0 0 8.4 0 18.8 0 31.7 19 50 19 50S38 31.7 38 18.8C38 8.4 29.5 0 19 0Z" fill="${color}" stroke="#fff" stroke-width="1.5"/>
      <circle cx="19" cy="18.5" r="12.5" fill="#fff"/>
      <g transform="translate(11,10.5) scale(0.667)" fill="none" stroke="${color}" color="${color}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${glyph}</g>
    </svg>`;
  return L.divIcon({
    className: 'cc-pin-wrap',
    html: svg,
    iconSize: [38, 50],
    iconAnchor: [19, 48],
    popupAnchor: [0, -44],
  });
}

const meIcon = L.divIcon({
  className: 'cc-me-wrap',
  html: '<div class="cc-me"></div>',
  iconSize: [18, 18],
  iconAnchor: [9, 9],
});

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
    btn.innerHTML = `${iconSvg('car', { size: 14 })} Quiero cargar`;
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
        btnHtml = `<button class="row-btn" data-pedir="${esc(c.chargerId)}">${iconSvg('car', { size: 14 })} Quiero cargar</button>`;
      }

      return `
        <div class="charger-row ${c.chargerId === chargerIdResaltado ? 'highlight' : ''}" data-row="${esc(c.chargerId)}">
          <div class="row-icon" style="background:${v.color}22">${iconSvg(v.icon, { size: 20, color: v.color })}</div>
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

// chargerId -> { marker, colorActual, iconoActual }. Actualizamos los
// marcadores existentes en vez de destruir y recrear todo en cada refresh
// (cada 3-4s): recrearlos siempre reinicia la animación de "caída" del CSS
// (.cc-pin-wrap) en TODOS los pines todo el tiempo, y eso es justo lo que
// se veía como "titileo" — no algo exclusivo del estado desconectado.
// Ahora un pin solo se vuelve a dibujar (y anima) cuando su color/ícono
// realmente cambia; la posición se actualiza siempre, pero moverlo no
// recrea el DOM así que no dispara la animación.
const marcadoresCargadores = new Map();

function renderMapa(chargers) {
  const conCoords = chargers.filter((c) => c.lat != null && c.lng != null);
  const idsVistos = new Set();

  conCoords.forEach((c) => {
    const v = VIEW[c.status] || VIEW['Nunca conectado'];
    idsVistos.add(c.chargerId);

    const existente = marcadoresCargadores.get(c.chargerId);

    if (!existente) {
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
      marcadoresCargadores.set(c.chargerId, { marker, color: v.color, icon: v.icon });
      return;
    }

    existente.marker.setLatLng([c.lat, c.lng]);

    if (existente.color !== v.color || existente.icon !== v.icon) {
      existente.marker.setIcon(pinIcon(v.color, v.icon));
      existente.color = v.color;
      existente.icon = v.icon;
    }

    existente.marker.setPopupContent(
      `<div class="popup-name">${esc(c.name)}</div><div class="popup-status">${esc(v.label)}</div>`
    );
  });

  // Cargadores que ya no están (se borraron): sacamos su marcador.
  for (const [chargerId, { marker }] of marcadoresCargadores) {
    if (!idsVistos.has(chargerId)) {
      capaCargadores.removeLayer(marker);
      marcadoresCargadores.delete(chargerId);
    }
  }

  if (!vistaCentrada) {
    const puntos = conCoords.map((c) => [c.lat, c.lng]);
    if (miPos) puntos.push([miPos.lat, miPos.lng]);
    if (puntos.length > 0) {
      // Padding asimétrico: la hoja tapa un 42% de abajo y el pill flota
      // arriba. Sin esto, fitBounds centra los puntos en el medio del DIV
      // completo del mapa y terminan escondidos detrás de la hoja.
      const sheetPeekPx = window.innerHeight * (SHEET_PEEK_VH / 100);
      map.fitBounds(puntos, {
        paddingTopLeft: [30, 90],
        paddingBottomRight: [30, sheetPeekPx + 30],
        maxZoom: 16,
      });
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

      // Círculo de precisión GPS, como en Google Maps/Waze.
      if (!circuloPrecision) {
        circuloPrecision = L.circle([miPos.lat, miPos.lng], {
          radius: pos.coords.accuracy || 30,
          color: '#2563eb',
          weight: 1,
          fillColor: '#2563eb',
          fillOpacity: 0.12,
          interactive: false,
        }).addTo(map);
      } else {
        circuloPrecision.setLatLng([miPos.lat, miPos.lng]);
        circuloPrecision.setRadius(pos.coords.accuracy || 30);
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

// ---- Hoja inferior arrastrable ----
// Dos posiciones (asomada/expandida). Arrastrar el "handle" mueve la altura
// en vivo; al soltar, redondea a la posición más cercana. Un toque sin
// arrastre (dragMoved sigue en false) alterna entre las dos.
const sheet = $('sheet');
const sheetDrag = $('sheetDrag');
const PEEK_VH = 42;
const EXPANDED_VH = 80;
let sheetExpandida = false;
let arrastrando = false;
let dragMoved = false;
let dragStartY = 0;
let dragStartAltura = 0;

const vhToPx = (vh) => (window.innerHeight * vh) / 100;
const setSheetHeight = (css) => document.documentElement.style.setProperty('--sheet-h', css);

function snapSheet(expandida) {
  sheetExpandida = expandida;
  setSheetHeight(`${expandida ? EXPANDED_VH : PEEK_VH}vh`);
}

sheetDrag.addEventListener('pointerdown', (e) => {
  arrastrando = true;
  dragMoved = false;
  document.body.classList.add('dragging-sheet');
  dragStartY = e.clientY;
  dragStartAltura = sheet.getBoundingClientRect().height;
  sheetDrag.setPointerCapture(e.pointerId);
});

sheetDrag.addEventListener('pointermove', (e) => {
  if (!arrastrando) return;
  const dy = dragStartY - e.clientY;
  if (Math.abs(dy) > 6) dragMoved = true;
  const nuevaAltura = Math.min(vhToPx(88), Math.max(vhToPx(18), dragStartAltura + dy));
  setSheetHeight(`${nuevaAltura}px`);
});

function terminarDrag() {
  if (!arrastrando) return;
  arrastrando = false;
  document.body.classList.remove('dragging-sheet');

  if (!dragMoved) {
    snapSheet(!sheetExpandida);
    return;
  }

  const vh = (sheet.getBoundingClientRect().height / window.innerHeight) * 100;
  snapSheet(vh > (PEEK_VH + EXPANDED_VH) / 2);
}

sheetDrag.addEventListener('pointerup', terminarDrag);
sheetDrag.addEventListener('pointercancel', terminarDrag);

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
