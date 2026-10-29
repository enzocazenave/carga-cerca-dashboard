'use strict';

// Un cargador del anfitrión: estado en vivo, configuración (precio, reglas,
// ubicación) y, con cargas.js, el historial y las reseñas.
const $ = (id) => document.getElementById(id);
const chargerId = decodeURIComponent(location.pathname.split('/').pop());
const url = `/api/panel/chargers/${encodeURIComponent(chargerId)}`;

function fmtDur(ms) {
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return m ? `${m} min ${String(s).padStart(2, '0')} s` : `${s} s`;
}

function renderLive(c) {
  const [cls, label] = panelStatus(c.status);
  document.title = `CargaCerca · ${c.name}`;
  $('name').textContent = c.name;
  $('statusDot').className = `dot ${cls}`;
  $('statusText').textContent = label;
  $('loc').textContent = c.location || '';

  const box = $('liveBox');
  if (c.session) {
    const s = c.session;
    box.className = 'live-box charging';
    box.innerHTML = `
      <h2>Cargando ahora${s.driverName ? `, ${panelEsc(s.driverName)}` : ''}</h2>
      <p>Cuando termine vas a poder dejarle una reseña.</p>
      <div class="live-grid">
        <div><div class="label">Tiempo</div><div class="value">${fmtDur(s.durationMs)}</div></div>
        <div><div class="label">Energía</div><div class="value">${panelEnergy(s.billedEnergyWh)}</div></div>
        <div><div class="label">Cobrado hasta ahora</div><div class="value">${panelMoney(s.amount, s.currency)}</div></div>
      </div>`;
  } else if (c.pendingRequest) {
    const rep = fmtReputation(c.pendingRequest.reputation);
    box.className = 'live-box request';
    box.innerHTML = `<h2>${panelEsc(c.pendingRequest.name)} pidió cargar</h2>
      <p>${rep ? `Reputación ${rep} de otros anfitriones.` : 'Es su primera carga en CargaCerca, todavía no tiene reseñas.'}</p>`;
  } else {
    box.className = 'live-box';
    box.innerHTML = cls === 'disconnected' || cls === 'never'
      ? '<h2>Tu cargador no está conectado</h2><p>Revisá que el medidor tenga luz y WiFi. Mientras tanto no aparece como libre en el mapa.</p>'
      : '<h2>Libre</h2><p>Aparece en el mapa para los conductores cercanos.</p>';
  }
}

// El formulario se llena una sola vez: el refresco en vivo no lo pisa.
function fillForm(c, generalPrice) {
  $('cName').value = c.name;
  $('cPrice').value = c.ownPricePerKwh ?? '';
  $('cPrice').placeholder = String(generalPrice);
  $('cPriceHint').textContent = `Vacío usa el sugerido (${panelMoney(generalPrice, c.currency)}). Se aplica a las cargas nuevas.`;
  $('cLoc').value = c.location || '';
  $('cDesc').value = c.description || '';
  $('cLat').value = c.lat ?? '';
  $('cLng').value = c.lng ?? '';
}

$('configForm').addEventListener('input', () => ($('cSaved').textContent = ''));
$('configForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const v = (id) => $(id).value.trim();
  $('cErr').textContent = '';
  try {
    const c = await panelApi(
      `/api/chargers/${encodeURIComponent(chargerId)}`,
      panelJson('PUT', {
        name: v('cName'),
        location: v('cLoc'),
        description: v('cDesc'),
        pricePerKwh: v('cPrice') === '' ? null : Number(v('cPrice')),
        lat: v('cLat') === '' ? null : Number(v('cLat')),
        lng: v('cLng') === '' ? null : Number(v('cLng')),
      })
    );
    $('cSaved').textContent = 'Cambios guardados';
    $('name').textContent = c.name;
  } catch (ex) {
    $('cErr').textContent = ex.message;
  }
});

$('cUseLoc').addEventListener('click', () => {
  if (!navigator.geolocation) {
    $('cLocHint').textContent = 'Este navegador no puede compartir tu ubicación';
    return;
  }
  $('cLocHint').textContent = 'Buscando tu ubicación…';
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      $('cLat').value = pos.coords.latitude.toFixed(6);
      $('cLng').value = pos.coords.longitude.toFixed(6);
      $('cLocHint').textContent = `Listo (precisión ±${Math.round(pos.coords.accuracy)} m). Guardá para aplicarlo.`;
    },
    (err) => ($('cLocHint').textContent = `No pudimos obtener tu ubicación: ${err.message}`),
    { enableHighAccuracy: true, timeout: 10000 }
  );
});

(async () => {
  mountUserMenu($('userMenu'));
  let c;
  try {
    c = await panelApi(url);
  } catch (e) {
    $('name').textContent = e.message;
    $('configForm').hidden = true;
    return;
  }
  const cfg = await fetch('/api/config').then((r) => r.json()).catch(() => ({ pricePerKwh: c.pricePerKwh }));
  renderLive(c);
  fillForm(c, cfg.pricePerKwh);
  setInterval(async () => renderLive(await panelApi(url)), 3000);
})();
