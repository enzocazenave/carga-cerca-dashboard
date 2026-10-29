'use strict';

// Panel del anfitrión: ingresos por período, sus cargadores en vivo y las
// últimas cargas. Todo viene filtrado por el servidor a sus cargadores.
const $ = (id) => document.getElementById(id);
let period = '30d';
let chart = null;

const fmtFecha = (iso) => {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
// Día calendario en Argentina (UTC-3), igual que los totales del servidor.
const diaAR = (ms) => new Date(ms - 3 * 3600000).toISOString().slice(0, 10);

function renderKpis(t) {
  const pend = t.pendingReviews
    ? `<a class="metric" href="#ultimas"><div class="label">Reseñas pendientes</div><div class="big warn">${t.pendingReviews}</div><div class="small">Calificá a quienes cargaron</div></a>`
    : '<div class="metric"><div class="label">Reseñas pendientes</div><div class="big">0</div><div class="small">Estás al día</div></div>';
  const pct = t.amount ? Math.round((t.commission / t.amount) * 100) : 15;
  $('kpis').innerHTML = `
    <div class="metric hero"><div class="label">Tus ingresos</div><div class="big">${panelMoney(t.hostNet, t.currency)}</div>
      <div class="small">De ${panelMoney(t.amount, t.currency)} cobrados, menos ${pct}% de comisión</div></div>
    <div class="metric"><div class="label">Cargas</div><div class="big">${t.sessions}</div></div>
    <div class="metric"><div class="label">Energía entregada</div><div class="big">${panelEnergy(t.billedEnergyWh)}</div></div>
    <div class="metric"><div class="label">Conductores</div><div class="big">${t.drivers}</div><div class="small">distintos</div></div>
    ${pend}`;
}

// Barras de una sola serie (ingreso neto por día). Días sin cargas van en 0
// para que el eje de tiempo no mienta.
function renderChart(byDay, from, currency) {
  if (period === 'hoy') {
    $('incomeChart').parentElement.hidden = true;
    $('chartEmpty').hidden = false;
    $('chartEmpty').textContent = 'Elegí 7 o 30 días para ver cómo vienen tus ingresos día a día.';
    return;
  }
  $('incomeChart').parentElement.hidden = false;
  $('chartEmpty').hidden = true;

  const porDia = new Map(byDay.map((d) => [d.day, d]));
  const start = from ? Date.parse(from) : byDay.length ? Date.parse(`${byDay[0].day}T12:00:00-03:00`) : Date.now() - 29 * 86400000;
  const labels = [];
  const values = [];
  const sessions = [];
  for (let t = start; diaAR(t) <= diaAR(Date.now()); t += 86400000) {
    const day = diaAR(t);
    const d = porDia.get(day);
    labels.push(`${day.slice(8, 10)}/${day.slice(5, 7)}`);
    values.push(d ? d.hostNet : 0);
    sessions.push(d ? d.sessions : 0);
  }

  const data = {
    labels,
    datasets: [{
      data: values,
      backgroundColor: '#4E80EE',
      hoverBackgroundColor: '#3567D9',
      borderRadius: { topLeft: 4, topRight: 4 },
      borderSkipped: 'bottom',
      maxBarThickness: 24,
    }],
  };
  if (chart) {
    chart.data = data;
    chart.update();
    return;
  }
  chart = new Chart($('incomeChart'), {
    type: 'bar',
    data,
    options: {
      animation: false,
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          displayColors: false,
          callbacks: {
            title: (items) => items[0].label,
            label: (item) => `${panelMoney(item.parsed.y, currency)} · ${sessions[item.dataIndex]} ${sessions[item.dataIndex] === 1 ? 'carga' : 'cargas'}`,
          },
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: '#5B6275', maxTicksLimit: 10, maxRotation: 0 } },
        y: {
          beginAtZero: true,
          grid: { color: '#EEF0F3' },
          border: { display: false },
          ticks: { color: '#5B6275', maxTicksLimit: 5, callback: (v) => `$ ${Math.round(v).toLocaleString('es-AR')}` },
        },
      },
    },
  });
}

function renderRecent(list) {
  if (!list.length) {
    $('recentBody').innerHTML = '<tr><td colspan="7" class="empty-cell">Cuando alguien cargue en tus cargadores, lo vas a ver acá.</td></tr>';
    return;
  }
  $('recentBody').innerHTML = list
    .map((s) => {
      const rep = s.driver && fmtReputation(s.driver.reputation);
      const driver = s.driver
        ? `<b>${panelEsc(s.driver.name)}</b>${s.driver.reputation ? `<span class="rep${rep ? '' : ' new'}">${rep || 'Sin reseñas'}</span>` : ''}`
        : '<span class="muted">Sin identificar</span>';
      const link = `/anfitrion/cargadores/${encodeURIComponent(s.chargerId)}`;
      let review = '<span class="muted">—</span>';
      if (s.review) review = `<span class="stars-static">${'★'.repeat(s.review.rating)}${'☆'.repeat(5 - s.review.rating)}</span>`;
      else if (s.reviewable) review = `<a class="pill-warn" href="${link}#review-${s.id}">Reseñar</a>`;
      return `<tr>
        <td>${fmtFecha(s.startedAt)}${s.endedAt ? '' : ' <span class="pill-live">en curso</span>'}</td>
        <td><a href="${link}">${panelEsc(s.chargerName)}</a></td>
        <td>${driver}</td>
        <td>${panelEnergy(s.billedEnergyWh)}</td>
        <td>${panelMoney(s.amount, s.currency)}</td>
        <td><b>${panelMoney(s.hostNet, s.currency)}</b></td>
        <td>${review}</td>
      </tr>`;
    })
    .join('');
}

function renderChargers(list) {
  if (!list.length) {
    $('chargers').innerHTML = '<div class="empty">Todavía no tenés cargadores asignados. Escribinos y te instalamos el medidor.</div>';
    return;
  }
  $('chargers').innerHTML = list
    .map((c) => {
      const [cls, label] = panelStatus(c.status);
      const st = c.sessionStats;
      let live = '';
      if (c.session) {
        live = `<div class="hc-live charging">Cargando ${c.session.driverName ? `<b>${panelEsc(c.session.driverName)}</b>` : ''} · ${panelEnergy(c.session.billedEnergyWh)} · ${panelMoney(c.session.amount, c.session.currency)}</div>`;
      } else if (c.pendingRequest) {
        const rep = fmtReputation(c.pendingRequest.reputation) || 'Sin reseñas todavía';
        live = `<div class="hc-live request">Pidió cargar <b>${panelEsc(c.pendingRequest.name)}</b> · ${rep}</div>`;
      }
      return `
        <a class="host-charger" href="/anfitrion/cargadores/${encodeURIComponent(c.chargerId)}">
          <div class="hc-top"><b>${panelEsc(c.name)}</b><span class="status"><span class="dot ${cls}"></span>${label}</span></div>
          <div class="hc-loc">${panelEsc(c.location || 'Sin ubicación cargada')}</div>
          ${live}
          <div class="hc-foot">
            <span><b>${panelMoney(c.pricePerKwh, c.currency)}</b>/kWh</span>
            <span>${st.sessions} ${st.sessions === 1 ? 'carga' : 'cargas'}</span>
            <span>Ganaste <b>${panelMoney(st.hostNet, st.currency)}</b></span>
            ${st.pendingReviews ? `<span class="card-badge">${st.pendingReviews} para reseñar</span>` : ''}
          </div>
          <span class="hc-cta">Ver cargas y configurar →</span>
        </a>`;
    })
    .join('');
}

async function loadSummary() {
  const s = await panelApi(`/api/summary?period=${period}`);
  renderKpis(s.totals);
  renderChart(s.byDay, s.from, s.totals.currency);
  renderRecent(s.recent);
}

async function loadChargers() {
  renderChargers(await panelApi('/api/panel/chargers'));
}

document.querySelectorAll('[data-period]').forEach((b) =>
  b.addEventListener('click', () => {
    period = b.dataset.period;
    document.querySelectorAll('[data-period]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    loadSummary();
  })
);
document.querySelector('#recentBody').closest('.table-wrap').id = 'ultimas';

(async () => {
  const user = await mountUserMenu($('userMenu'));
  if (user) $('hello').textContent = `Hola, ${user.name.split(' ')[0]}`;
  await Promise.all([loadSummary(), loadChargers()]);
  setInterval(loadChargers, 3000);
  setInterval(loadSummary, 15000);
})();
