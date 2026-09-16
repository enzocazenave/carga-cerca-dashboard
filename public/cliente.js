'use strict';

const chargerId = decodeURIComponent(location.pathname.split('/').pop());
const $ = (id) => document.getElementById(id);

$('techLink').href = `/chargers/${encodeURIComponent(chargerId)}`;

// Mapa de estados técnicos -> presentación amigable para el cliente.
// `icon` es un nombre de /public/icons.js (CC_ICONS), no un emoji.
const VIEW = {
  'Cargando': { cls: 'charging', icon: 'bolt', title: 'Cargando', sub: 'Velocidad de carga' },
  'Consumo bajo': { cls: 'low', icon: 'batteryLow', title: 'Carga lenta', sub: 'Consumo bajo' },
  'Disponible': { cls: 'idle', icon: 'plug', title: 'Listo para cargar', sub: 'Enchufá tu auto al cargador' },
  'Esperando tarjeta': { cls: 'idle', icon: 'card', title: 'Acercá tu tarjeta', sub: 'Apoyá tu tarjeta o llavero en el lector del cargador' },
  'Tarjeta leída · esperando inicio': { cls: 'low', icon: 'arrowRightCircle', title: 'Tarjeta leída', sub: 'Tocá "Iniciar carga" en la pantalla del cargador' },
  'Carga finalizada': { cls: 'idle', icon: 'checkCircle', title: 'Carga finalizada', sub: 'Ya podés retirar el cable' },
  'Desconectado': { cls: 'off', icon: 'alertTriangle', title: 'Sin conexión', sub: 'No estamos recibiendo datos' },
  'Nunca conectado': { cls: 'off', icon: 'plug', title: 'Esperando conexión', sub: 'Todavía no llegaron datos' },
};

let cfg = { pricePerKwh: 0, currency: 'ARS', kmPerKwh: 6 };
let sessionStartMs = null; // para el cronómetro local entre refrescos
let prevStatus = null; // para animar solo en la transición a "Carga finalizada"

function fmtDuration(ms) {
  const t = Math.max(0, Math.floor(ms / 1000));
  const h = String(Math.floor(t / 3600)).padStart(2, '0');
  const m = String(Math.floor((t % 3600) / 60)).padStart(2, '0');
  const s = String(t % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function fmtEnergy(wh) {
  if (wh == null) return '—';
  if (wh < 1000) return `${wh.toFixed(wh < 100 ? 1 : 0)} <small>Wh</small>`;
  return `${(wh / 1000).toFixed(2)} <small>kWh</small>`;
}

function fmtMoney(value) {
  try {
    return new Intl.NumberFormat('es-AR', { style: 'currency', currency: cfg.currency, maximumFractionDigits: 0 }).format(value);
  } catch {
    return `$ ${value.toFixed(0)}`;
  }
}

function fmtClock(iso) {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function fmtAgo(iso) {
  if (!iso) return 'nunca';
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `hace ${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `hace ${m} min`;
  return `hace ${Math.floor(m / 60)} h`;
}

// ---- Chart ----
const chart = new Chart($('chart'), {
  type: 'line',
  data: { labels: [], datasets: [{ data: [], borderColor: '#16a34a', borderWidth: 2.5, fill: true, tension: 0.35, pointRadius: 0 }] },
  options: {
    animation: false,
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false }, tooltip: { enabled: false } },
    scales: {
      x: { display: false },
      y: { display: false, beginAtZero: true, grace: '10%' },
    },
  },
});
// gradiente de relleno
const gctx = $('chart').getContext('2d');
const grad = gctx.createLinearGradient(0, 0, 0, 120);
grad.addColorStop(0, 'rgba(22,163,74,0.28)');
grad.addColorStop(1, 'rgba(22,163,74,0)');
chart.data.datasets[0].backgroundColor = grad;

async function api(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

// ---- Quiero cargar mi auto ----
// El nombre se pide una sola vez y queda en este navegador: así la próxima
// visita ya no pregunta y el flujo se siente instantáneo.
const NAME_KEY = 'cc_client_name';
const getMyName = () => (localStorage.getItem(NAME_KEY) || '').trim() || null;

async function pedirCarga() {
  let name = getMyName();
  if (!name) {
    name = (prompt('¿Cómo te llamás? Así te saludamos en el cargador.') || '').trim();
    if (!name) return;
    localStorage.setItem(NAME_KEY, name);
  }

  const btn = $('requestBtn');
  btn.disabled = true;
  btn.textContent = 'Enviando…';
  try {
    await api(`/api/chargers/${encodeURIComponent(chargerId)}/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    await refresh();
  } catch (e) {
    alert(e.message);
    btn.disabled = false;
    btn.innerHTML = etiquetaPedirCarga();
  }
}

$('requestBtn').addEventListener('click', pedirCarga);

function etiquetaPedirCarga() {
  return `${iconSvg('car', { size: 16 })} Quiero cargar mi auto`;
}

function actualizarRequestCard(charger) {
  const card = $('requestCard');
  const btn = $('requestBtn');
  const hint = $('requestHint');
  const pr = charger.pendingRequest;
  const myName = getMyName();

  if (charger.status === 'Cargando') {
    card.hidden = true;
    return;
  }
  card.hidden = false;

  if (pr && pr.name) {
    btn.disabled = true;
    if (myName && pr.name === myName) {
      btn.innerHTML = `${iconSvg('checkCircle', { size: 16 })} Solicitud enviada`;
      hint.textContent = 'Acercate y apoyá tu tarjeta en el cargador';
      hint.className = 'request-hint mine';
    } else {
      btn.textContent = 'Cargador reservado';
      hint.textContent = `${pr.name} está por cargar acá`;
      hint.className = 'request-hint';
    }
  } else {
    btn.disabled = false;
    btn.innerHTML = etiquetaPedirCarga();
    hint.textContent = '';
    hint.className = 'request-hint';
  }
}

async function loadConfig() {
  try { cfg = await api('/api/config'); } catch { /* usa defaults */ }
}

async function refresh() {
  let charger, measurements;
  try {
    [charger, measurements] = await Promise.all([
      api(`/api/chargers/${encodeURIComponent(chargerId)}`),
      api(`/api/chargers/${encodeURIComponent(chargerId)}/measurements?limit=100`),
    ]);
  } catch (e) {
    $('banner').innerHTML = `<div class="banner">${e.message}</div>`;
    return;
  }
  $('banner').innerHTML = '';

  document.title = `CargaCerca · ${charger.name}`;
  $('name').textContent = charger.name;
  $('loc').textContent = charger.location || '';

  const v = VIEW[charger.status] || VIEW['Nunca conectado'];
  $('hero').className = 'hero ' + v.cls;
  $('badge').innerHTML = iconSvg(v.icon, { size: 34, color: '#fff', strokeWidth: 1.8 });
  $('status').textContent = v.title;
  $('sub').textContent = v.sub;

  if (charger.status === 'Carga finalizada' && prevStatus !== 'Carga finalizada') {
    $('badge').classList.add('pop');
    setTimeout(() => $('badge').classList.remove('pop'), 600);
  }
  prevStatus = charger.status;

  actualizarRequestCard(charger);

  // Si la solicitud pendiente es la mía, personalizamos el mensaje del
  // cargador (lo mismo que ve en su pantalla física la ESP32).
  const myName = getMyName();
  const pr = charger.pendingRequest;
  if (pr && myName && pr.name === myName) {
    if (charger.status === 'Esperando tarjeta') {
      $('sub').textContent = `¡Hola, ${myName}! Acercá tu tarjeta al cargador.`;
    } else if (charger.status === 'Tarjeta leída · esperando inicio') {
      $('sub').textContent = `¡Hola, ${myName}! Tocá "Iniciar carga" en la pantalla.`;
    }
  }

  const m = charger.latest;
  const powerKw = m && m.powerMw != null ? m.powerMw / 1e6 : 0;
  $('power').textContent = powerKw.toFixed(2);

  // Señal en vivo
  const liveOn = charger.status !== 'Desconectado' && charger.status !== 'Nunca conectado';
  $('live').className = 'live' + (liveOn ? ' on' : '');
  $('live').textContent = liveOn ? 'en vivo' : 'sin señal';

  // Sesión
  const s = charger.session;
  if (s) {
    sessionStartMs = Date.parse(s.start);
    const energyWh = s.energyWh * 1000;
    $('energy').innerHTML = fmtEnergy(energyWh);
    const km = (energyWh / 1000) * (cfg.kmPerKwh || 6);
    $('energyKm').textContent = `≈ ${km.toFixed(1)} km de autonomía`;
    $('since').textContent = `Desde las ${fmtClock(s.start)}`;

    if (cfg.pricePerKwh > 0) {
      const cost = (energyWh / 1000) * cfg.pricePerKwh;
      $('costValue').textContent = fmtMoney(cost);
      $('costHint').textContent = `${fmtMoney(cfg.pricePerKwh)} / kWh`;
      $('costCard').hidden = false;
    } else {
      $('costCard').hidden = true;
    }
  } else {
    sessionStartMs = null;
    $('energy').innerHTML = '0 <small>Wh</small>';
    $('energyKm').textContent = '≈ 0 km de autonomía';
    $('duration').textContent = '00:00:00';
    $('since').textContent = 'Sin sesión activa';
    $('costCard').hidden = true;
  }
  tickDuration();

  // Detalles técnicos
  const n = (x, d = 2) => (x == null ? '—' : Number(x).toFixed(d));
  $('tBus').textContent = m ? `${n(m.busVoltage)} V` : '—';
  $('tSrc').textContent = m ? `${n(m.sourceVoltage)} V` : '—';
  $('tCur').textContent = m ? `${n(m.currentMa / 1000)} A` : '—';
  $('tPow').textContent = m ? `${n(m.powerMw / 1000, 0)} mW` : '—';
  $('tShu').textContent = m ? `${n(m.shuntVoltageMv)} mV` : '—';
  $('tSeen').textContent = fmtAgo(charger.lastSeenAt);

  // Chart
  chart.data.labels = measurements.map((x) => x.createdAt);
  chart.data.datasets[0].data = measurements.map((x) => (x.powerMw != null ? x.powerMw / 1e6 : 0));
  chart.resize();
  chart.update();
}

// Cronómetro local: avanza cada segundo entre refrescos para que se sienta "en vivo"
function tickDuration() {
  if (sessionStartMs == null) return;
  $('duration').textContent = fmtDuration(Date.now() - sessionStartMs);
}

(async () => {
  await loadConfig();
  await refresh();
  setInterval(refresh, 2000);
  setInterval(tickDuration, 1000);
})();
