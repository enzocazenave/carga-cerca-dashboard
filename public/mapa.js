'use strict';

const $ = (id) => document.getElementById(id);
// getMyName / askMyName / requestBody vienen de /public/conductor.js

// Mismo criterio "amigable" que la vista cliente (ver public/cliente.js),
// pero acá solo necesitamos ícono + color, no toda la copy larga. `icon` es
// el nombre de un ícono de /public/icons.js (CC_ICONS), no un emoji: así se
// ve igual en cualquier navegador/SO y se puede pintar del color del estado.
// Sigue los pines del libro de marca: cargador libre = círculo azul con una
// casa, en uso = verde, no disponible = atenuado (`dim`). El halo queda
// solo para el pin del conductor, para no confundirlo con un cargador.
// `color` pinta pines e íconos; `ink` es la variante oscura para el texto
// chico del estado (el verde/azul de marca no llegan a contraste AA, ver
// /public/brand.css). Colores en hex literal (no var(--...)): se concatenan
// con un sufijo de alpha más abajo (`${color}22`) para el fondo tenue de
// los íconos de la lista, y eso solo funciona con valores hex reales.
const VIEW = {
  'Cargando': { icon: 'bolt', color: '#4CA154', ink: '#2E7D36', label: 'Cargando' },
  'Consumo bajo': { icon: 'batteryLow', color: '#D97706', ink: '#B45309', label: 'Carga lenta' },
  'Disponible': { icon: 'home', color: '#4E80EE', ink: '#2F5FCC', label: 'Libre' },
  'Esperando tarjeta': { icon: 'home', color: '#4E80EE', ink: '#2F5FCC', label: 'Libre' },
  'Tarjeta leída · esperando inicio': { icon: 'arrowRightCircle', color: '#D97706', ink: '#B45309', label: 'Alguien está por cargar' },
  'Carga finalizada': { icon: 'home', color: '#4E80EE', ink: '#2F5FCC', label: 'Libre' },
  'Desconectado': { icon: 'alertTriangle', color: '#8A90A0', ink: '#5B6275', label: 'Sin conexión', dim: true },
  'Nunca conectado': { icon: 'home', color: '#8A90A0', ink: '#5B6275', label: 'Sin datos aún', dim: true },
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

// ---- Base del mapa ----
// Calles vectoriales de OpenFreeMap (gratis, sin API key ni registro) con su
// estilo claro "positron", recoloreado acá con la paleta de marca: calles
// blancas sobre gris frío, agua y plazas con un toque del azul y el verde de
// marca, textos en navy. Así los pines (azul = cargador, verde = vos) son lo
// que más resalta. Antes usábamos los tiles raster de Esri (World Street
// Map), que no se pueden recolorear y se veían amarillentos. CARTO, la otra
// opción gratis, ya exige API key.
// Siempre en claro: toda la app cliente queda fija en modo claro a
// propósito, para que combine con la pantalla física del cargador.
const MAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/positron';
const MAP_COLORS = {
  background: { 'background-color': '#EEF0F4' },
  park: { 'fill-color': '#DDEBDD' },
  landcover_wood: { 'fill-color': '#D7E8D8' },
  water: { 'fill-color': '#CCDAF5' },
  waterway: { 'line-color': '#BACDF2' },
  landuse_residential: { 'fill-color': '#E9ECF1' },
  building: { 'fill-color': '#E2E5EC', 'fill-outline-color': '#D6DAE3' },
  highway_path: { 'line-color': '#FFFFFF' },
  highway_minor: { 'line-color': '#FFFFFF', 'line-opacity': 1 },
  highway_major_casing: { 'line-color': '#D5DAE4' },
  highway_major_inner: { 'line-color': '#FFFFFF' },
  highway_major_subtle: { 'line-color': '#FFFFFF' },
  highway_motorway_casing: { 'line-color': '#CDD3DF' },
  highway_motorway_inner: { 'line-color': '#FFFFFF' },
  highway_motorway_bridge_casing: { 'line-color': '#CDD3DF' },
  highway_motorway_bridge_inner: { 'line-color': '#FFFFFF' },
  railway: { 'line-color': '#D5DAE4' },
  railway_transit: { 'line-color': '#D5DAE4' },
  railway_service: { 'line-color': '#D5DAE4' },
};

function estiloDeMarca(style) {
  style.layers.forEach((layer) => {
    Object.assign((layer.paint = layer.paint || {}), MAP_COLORS[layer.id]);
    if (layer.type === 'symbol' && layer.paint['text-color'] !== undefined) {
      // Nombres de calles en gris de marca; barrios y lugares en navy; agua en azul.
      layer.paint['text-color'] = /water/.test(layer.id) ? '#3567D9' : /highway-name/.test(layer.id) ? '#5B6275' : '#111729';
      layer.paint['text-halo-color'] = '#EEF0F4';
    }
  });
  return style;
}

function hayWebGL() {
  try {
    const c = document.createElement('canvas');
    return !!(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl')));
  } catch {
    return false;
  }
}

const atribucion = L.control.attribution({ position: 'bottomleft', prefix: false }).addTo(map);

function baseRaster() {
  document.getElementById('map').classList.add('raster-fallback');
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19,
    maxNativeZoom: 19,
  }).addTo(map);
  atribucion.addAttribution('© <a href="https://www.esri.com">Esri</a> © OpenStreetMap contributors');
}

(async () => {
  if (!hayWebGL() || !L.maplibreGL) return baseRaster();
  try {
    const res = await fetch(MAP_STYLE_URL);
    if (!res.ok) throw new Error(`style ${res.status}`);
    L.maplibreGL({ style: estiloDeMarca(await res.json()), interactive: false }).addTo(map);
    atribucion.addAttribution(
      '<a href="https://openfreemap.org">OpenFreeMap</a> © <a href="https://www.openmaptiles.org">OpenMapTiles</a> © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    );
  } catch {
    baseRaster();
  }
})();

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

// Pin circular del libro de marca ("Elementos gráficos"): círculo de color
// con borde blanco y el ícono de estado (de CC_ICONS, ver /public/icons.js)
// en blanco adentro. `halo` agrega el anillo que late (solo el conductor);
// `dim` lo atenúa (no disponible). La sombra y las
// animaciones van en CSS (.cc-pin-wrap / .cc-halo), no acá, para no
// duplicar filtros SVG con el mismo id en cada marcador.
function circlePinSvg(color, iconName, halo) {
  const glyph = CC_ICONS[iconName] || '';
  return `
    <svg width="44" height="44" viewBox="0 0 44 44" xmlns="http://www.w3.org/2000/svg" overflow="visible">
      ${halo ? `<circle class="cc-halo" cx="22" cy="22" r="21" fill="${color}" opacity="0.35"/>` : ''}
      <circle cx="22" cy="22" r="15" fill="${color}" stroke="#fff" stroke-width="2.5"/>
      <g transform="translate(14,14) scale(0.667)" fill="none" stroke="#fff" color="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">${glyph}</g>
    </svg>`;
}

function pinIcon(v) {
  return L.divIcon({
    className: 'cc-pin-wrap' + (v.dim ? ' dim' : ''),
    html: circlePinSvg(v.color, v.icon, v.halo),
    iconSize: [44, 44],
    iconAnchor: [22, 22],
    popupAnchor: [0, -18],
  });
}

// "Pin de auto" de la marca: el conductor es siempre el círculo verde con halo.
const meIcon = L.divIcon({
  className: 'cc-me-wrap',
  html: circlePinSvg('#4CA154', 'car', true),
  iconSize: [44, 44],
  iconAnchor: [22, 22],
});

function popupHtml(c, v) {
  return `<div class="popup-name">${esc(c.name)}</div><div class="popup-status" style="--dot:${v.color}">${esc(v.label)}</div>`;
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

async function pedirCarga(charger, btn) {
  const name = askMyName();
  if (!name) return;

  btn.disabled = true;
  btn.textContent = 'Enviando…';
  try {
    await api(`/api/chargers/${encodeURIComponent(charger.chargerId)}/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: requestBody(name),
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

      // El precio lo pone cada anfitrión: el conductor lo ve antes de ir.
      const precio = c.pricePerKwh > 0 ? ` · $${Math.round(c.pricePerKwh)}/kWh` : '';
      let statusHtml = `<b style="color:${v.ink}">${v.label}</b>${precio}`;
      let btnHtml;

      if (busy) {
        btnHtml = `<button class="row-btn" disabled>Ocupado</button>`;
      } else if (pr && pr.name) {
        if (myName && pr.name === myName) {
          statusHtml = `<b style="color:var(--cc-green-ink)">Tu solicitud está activa</b>`;
          btnHtml = `<button class="row-btn ghost" data-goto="${esc(c.chargerId)}">Ver →</button>`;
        } else {
          // Los cargadores no se reservan (libro de marca, tono de voz): si
          // otro ya pidió este, solo avisamos que alguien está por cargar.
          statusHtml = `<b style="color:var(--cc-amber)">Alguien está por cargar</b>`;
          btnHtml = `<button class="row-btn" disabled>Ocupado</button>`;
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
      const marker = L.marker([c.lat, c.lng], { icon: pinIcon(v) }).addTo(capaCargadores);
      marker.bindPopup(popupHtml(c, v));
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
      existente.marker.setIcon(pinIcon(v));
      existente.color = v.color;
      existente.icon = v.icon;
    }

    existente.marker.setPopupContent(popupHtml(c, v));
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

      // Círculo de precisión GPS, como en Google Maps/Waze (verde: es el
      // conductor, igual que su pin).
      if (!circuloPrecision) {
        circuloPrecision = L.circle([miPos.lat, miPos.lng], {
          radius: pos.coords.accuracy || 30,
          color: '#4CA154',
          weight: 1,
          fillColor: '#4CA154',
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
