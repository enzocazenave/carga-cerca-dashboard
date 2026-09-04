'use strict';

const chargerId = decodeURIComponent(location.pathname.split('/').pop());

const STATUS_CLASS = {
  'Cargando': 'charging',
  'Consumo bajo': 'low',
  'Disponible': 'available',
  'Desconectado': 'disconnected',
  'Nunca conectado': 'never',
};

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
const $ = (id) => document.getElementById(id);
const n = (v, d = 2) => (v == null || Number.isNaN(Number(v)) ? '—' : Number(v).toFixed(d));

function fmtAgo(iso) {
  if (!iso) return 'nunca';
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `hace ${s} segundo${s === 1 ? '' : 's'}`;
  const m = Math.floor(s / 60);
  if (m < 60) return `hace ${m} minuto${m === 1 ? '' : 's'}`;
  const h = Math.floor(m / 60);
  return `hace ${h} hora${h === 1 ? '' : 's'}`;
}

function fmtDuration(ms) {
  const t = Math.max(0, Math.floor(ms / 1000));
  const h = String(Math.floor(t / 3600)).padStart(2, '0');
  const m = String(Math.floor((t % 3600) / 60)).padStart(2, '0');
  const s = String(t % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function fmtClock(iso) {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// --- Charts ---
const baseOpts = {
  animation: false,
  responsive: true,
  maintainAspectRatio: false,
  plugins: { legend: { display: false } },
  scales: {
    x: { ticks: { color: '#9aa3b2', maxTicksLimit: 6 }, grid: { color: '#2a2f3a' } },
    y: { ticks: { color: '#9aa3b2' }, grid: { color: '#2a2f3a' }, beginAtZero: true },
  },
  elements: { point: { radius: 0 } },
};

function makeChart(id, color) {
  return new Chart($(id), {
    type: 'line',
    data: { labels: [], datasets: [{ data: [], borderColor: color, backgroundColor: color + '22', borderWidth: 2, fill: true, tension: 0.25 }] },
    options: baseOpts,
  });
}

const charts = {
  current: makeChart('chartCurrent', '#22c55e'),
  power: makeChart('chartPower', '#3b82f6'),
  voltage: makeChart('chartVoltage', '#eab308'),
};

function updateChart(chart, labels, data) {
  chart.data.labels = labels;
  chart.data.datasets[0].data = data;
  chart.update();
}

async function api(path) {
  const res = await fetch(path);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

async function refresh() {
  let charger, measurements;
  try {
    [charger, measurements] = await Promise.all([
      api(`/api/chargers/${encodeURIComponent(chargerId)}`),
      api(`/api/chargers/${encodeURIComponent(chargerId)}/measurements?limit=100`),
    ]);
  } catch (e) {
    $('name').textContent = e.message;
    return;
  }

  document.title = `CargaCerca · ${charger.name}`;
  $('name').textContent = charger.name;
  $('cid').textContent = charger.chargerId;
  $('loc').textContent = charger.location || '—';

  $('statusText').textContent = charger.status;
  $('statusDot').className = 'dot ' + (STATUS_CLASS[charger.status] || 'never');
  $('lastSeen').textContent = fmtAgo(charger.lastSeenAt);

  const m = charger.latest;
  $('busV').textContent = m ? n(m.busVoltage) : '—';
  $('srcV').textContent = m ? n(m.sourceVoltage) : '—';
  $('currentA').textContent = m ? n(m.currentMa / 1000) : '—';
  $('currentMa').textContent = m ? n(m.currentMa, 0) : '—';
  $('powerW').textContent = m ? n(m.powerMw / 1000) : '—';
  $('powerMw').textContent = m ? n(m.powerMw, 0) : '—';
  $('shuntMv').textContent = m ? n(m.shuntVoltageMv) : '—';

  // Sesión
  const s = charger.session;
  if (!s) {
    $('sessionBox').innerHTML = '<div class="session-card"><div class="session-none">No hay una sesión de carga activa.</div></div>';
  } else {
    $('sessionBox').innerHTML = `
      <div class="session-card">
        <div class="item"><div class="label">Inicio</div><div class="value">${fmtClock(s.start)}</div></div>
        <div class="item"><div class="label">Duración</div><div class="value">${fmtDuration(s.durationMs)}</div></div>
        <div class="item"><div class="label">Corriente actual</div><div class="value">${n(s.currentMa / 1000)} A</div></div>
        <div class="item"><div class="label">Potencia actual</div><div class="value">${n(s.powerMw / 1000)} W</div></div>
        <div class="item"><div class="label">Energía entregada</div><div class="value">${n(s.energyWh)} Wh</div></div>
      </div>`;
  }

  // Charts
  const labels = measurements.map((x) => fmtClock(x.createdAt));
  updateChart(charts.current, labels, measurements.map((x) => x.currentMa / 1000));
  updateChart(charts.power, labels, measurements.map((x) => x.powerMw / 1000));
  updateChart(charts.voltage, labels, measurements.map((x) => x.busVoltage));
}

refresh();
setInterval(refresh, 2000);
