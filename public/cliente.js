'use strict';

const chargerId = decodeURIComponent(location.pathname.split('/').pop());
const $ = (id) => document.getElementById(id);

$('techLink').href = `/chargers/${encodeURIComponent(chargerId)}`;

// Mapa de estados técnicos -> presentación amigable para el cliente
const VIEW = {
  'Cargando': { cls: 'charging', icon: '⚡', title: 'Cargando', sub: 'Velocidad de carga' },
  'Consumo bajo': { cls: 'low', icon: '🔋', title: 'Carga lenta', sub: 'Consumo bajo' },
  'Disponible': { cls: 'idle', icon: '🔌', title: 'Listo para cargar', sub: 'Enchufá tu auto al cargador' },
  'Desconectado': { cls: 'off', icon: '⚠️', title: 'Sin conexión', sub: 'No estamos recibiendo datos' },
  'Nunca conectado': { cls: 'off', icon: '🔌', title: 'Esperando conexión', sub: 'Todavía no llegaron datos' },
};

let cfg = { pricePerKwh: 0, currency: 'ARS', kmPerKwh: 6 };
let sessionStartMs = null; // para el cronómetro local entre refrescos

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

async function api(path) {
  const res = await fetch(path);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
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
  $('badge').textContent = v.icon;
  $('status').textContent = v.title;
  $('sub').textContent = v.sub;

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
