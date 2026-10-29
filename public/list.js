'use strict';

const listEl = document.getElementById('list');
const emptyEl = document.getElementById('empty');
const modalRoot = document.getElementById('modalRoot');

const STATUS_CLASS = {
  'Cargando': 'charging',
  'Consumo bajo': 'low',
  'Disponible': 'available',
  'Esperando tarjeta': 'waiting-card',
  'Tarjeta leída · esperando inicio': 'waiting-start',
  'Carga finalizada': 'available',
  'Desconectado': 'disconnected',
  'Nunca conectado': 'never',
};

function fmtAgo(iso) {
  if (!iso) return 'nunca';
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `hace ${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `hace ${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `hace ${h}h`;
  return `hace ${Math.round(h / 24)}d`;
}

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function fmtMoney(value, currency) {
  try {
    return new Intl.NumberFormat('es-AR', { style: 'currency', currency: currency || 'ARS', maximumFractionDigits: value < 100 ? 2 : 0 }).format(value);
  } catch {
    return `$ ${value.toFixed(2)}`;
  }
}

// Quién pidió cargar y su reputación, para que el anfitrión sepa quién viene.
function requestLine(pr) {
  if (!pr || !pr.name) return '';
  const rep = fmtReputation(pr.reputation) || 'Sin reseñas todavía';
  return `<div class="card-line request">${iconSvg('car', { size: 13 })} Pidió cargar <b>${esc(pr.name)}</b> <span class="rep${pr.reputation && pr.reputation.count ? '' : ' new'}">${rep}</span></div>`;
}

function statsLine(c) {
  const st = c.sessionStats;
  if (!st || !st.sessions) return '<div class="seen">Sin cargas registradas</div>';
  const pend = st.pendingReviews
    ? ` <a class="card-badge" href="/chargers/${encodeURIComponent(c.chargerId)}#cargas">${st.pendingReviews} para reseñar</a>`
    : '';
  return `<div class="seen">${st.sessions} ${st.sessions === 1 ? 'carga' : 'cargas'} · ${fmtMoney(st.amount, st.currency)} cobrados${pend}</div>`;
}

// panelApi (ver /public/panel.js) manda a /login si la sesión venció.
const api = panelApi;

// Totales de toda la red en los últimos 30 días ("para nosotros").
async function loadSummary() {
  let s;
  try {
    s = (await api('/api/summary?period=30d')).totals;
  } catch {
    return;
  }
  document.getElementById('summary').innerHTML = `
    <div class="metric"><div class="label">Cobrado a conductores</div><div class="big">${fmtMoney(s.amount, s.currency)}</div></div>
    <div class="metric"><div class="label">Comisión CargaCerca</div><div class="big">${fmtMoney(s.commission, s.currency)}</div></div>
    <div class="metric"><div class="label">Pagado a anfitriones</div><div class="big">${fmtMoney(s.hostNet, s.currency)}</div></div>
    <div class="metric"><div class="label">Cargas</div><div class="big">${s.sessions}</div><div class="small">${s.drivers} conductores</div></div>`;
}

async function load() {
  let chargers;
  try {
    chargers = await api('/api/panel/chargers');
  } catch (e) {
    listEl.innerHTML = `<div class="empty">No se pudo cargar: ${esc(e.message)}</div>`;
    return;
  }

  emptyEl.hidden = chargers.length > 0;
  listEl.innerHTML = chargers.map((c) => {
    const cls = STATUS_CLASS[c.status] || 'never';
    const powerW = c.latest && c.latest.powerMw != null ? (c.latest.powerMw / 1000).toFixed(2) : '0.00';
    return `
      <div class="charger-card">
        <a href="/chargers/${encodeURIComponent(c.chargerId)}" style="display:flex;flex-direction:column;gap:4px">
          <div class="name">${esc(c.name)}</div>
          <div class="cid">${esc(c.chargerId)}</div>
          <div class="loc">${esc(c.location || '—')}</div>
          <div class="status"><span class="dot ${cls}"></span>${esc(c.status)}</div>
          <div class="power">${powerW} W</div>
          <div class="seen">Última conexión: ${fmtAgo(c.lastSeenAt)}</div>
          <div class="seen">${c.owner ? `Anfitrión <b>${esc(c.owner.name)}</b>` : 'Sin anfitrión asignado'} · ${fmtMoney(c.pricePerKwh, c.currency)}/kWh</div>
          ${c.session ? `<div class="card-line request">${iconSvg('bolt', { size: 13 })} Cargando <b>${esc(c.session.driverName || 'sin identificar')}</b></div>` : requestLine(c.pendingRequest)}
          <div class="seen" style="display:flex;align-items:center;gap:5px">${
            c.lat != null && c.lng != null
              ? iconSvg('mapPin', { size: 12 }) + ' En el mapa'
              : iconSvg('alertTriangle', { size: 12 }) + ' Sin coordenadas · no aparece en el mapa'
          }</div>
        </a>
        ${statsLine(c)}
        <div class="card-actions">
          <a class="btn link" href="/c/${encodeURIComponent(c.chargerId)}">Vista cliente</a>
          <button class="btn link" data-edit="${esc(c.chargerId)}">Editar</button>
          <button class="btn link" data-del="${esc(c.chargerId)}">Eliminar</button>
        </div>
      </div>`;
  }).join('');

  listEl.querySelectorAll('[data-edit]').forEach((b) =>
    b.addEventListener('click', () => {
      const c = chargers.find((x) => x.chargerId === b.dataset.edit);
      openModal(c);
    })
  );
  listEl.querySelectorAll('[data-del]').forEach((b) =>
    b.addEventListener('click', () => remove(b.dataset.del))
  );
}

async function remove(chargerId) {
  if (!confirm('¿Seguro que querés eliminar este cargador?')) return;
  try {
    await api(`/api/chargers/${encodeURIComponent(chargerId)}`, { method: 'DELETE' });
    load();
  } catch (e) {
    alert(e.message);
  }
}

let anfitriones = [];

async function openModal(charger) {
  const isEdit = !!charger;
  try {
    anfitriones = (await api('/api/users')).filter((u) => u.role === 'anfitrion');
  } catch {
    /* sin lista, el select queda solo con "Sin anfitrión" */
  }
  const ownerOptions = anfitriones
    .map((u) => `<option value="${u.id}" ${charger?.owner?.id === u.id ? 'selected' : ''}>${esc(u.name)} · ${esc(u.email)}</option>`)
    .join('');
  modalRoot.innerHTML = `
    <div class="modal-backdrop" id="backdrop">
      <div class="modal">
        <h2>${isEdit ? 'Editar cargador' : 'Agregar cargador'}</h2>
        <div class="modal-error" id="mErr"></div>
        <div class="field">
          <label>Nombre *</label>
          <input id="f-name" value="${esc(charger?.name || '')}" />
        </div>
        <div class="field">
          <label>Charger ID *</label>
          <input id="f-cid" value="${esc(charger?.chargerId || '')}" ${isEdit ? 'disabled' : ''} placeholder="CC-001" />
        </div>
        <div class="field-row two">
          <div class="field">
            <label>Anfitrión (dueño)</label>
            <select id="f-owner"><option value="">Sin anfitrión</option>${ownerOptions}</select>
          </div>
          <div class="field">
            <label>Precio por kWh</label>
            <input id="f-price" type="number" min="0" step="1" value="${charger?.ownPricePerKwh ?? ''}" placeholder="General" />
          </div>
        </div>
        <div class="field">
          <label>Ubicación (texto libre)</label>
          <input id="f-loc" value="${esc(charger?.location || '')}" placeholder="Estación de servicio YPF, Palermo" />
        </div>
        <div class="field">
          <label>Coordenadas (para el mapa del cliente)</label>
          <div class="field-row">
            <input id="f-lat" type="number" step="any" value="${charger?.lat ?? ''}" placeholder="Latitud" />
            <input id="f-lng" type="number" step="any" value="${charger?.lng ?? ''}" placeholder="Longitud" />
            <button type="button" class="btn secondary" id="mUseLoc" title="Usar mi ubicación actual">${iconSvg('mapPin', { size: 15 })}</button>
          </div>
          <div class="field-hint" id="mLocHint"></div>
        </div>
        <div class="field">
          <label>Descripción</label>
          <textarea id="f-desc">${esc(charger?.description || '')}</textarea>
        </div>
        <div class="modal-actions">
          <button class="btn secondary" id="mCancel">Cancelar</button>
          <button class="btn" id="mSave">${isEdit ? 'Guardar' : 'Crear cargador'}</button>
        </div>
      </div>
    </div>`;

  const close = () => (modalRoot.innerHTML = '');
  document.getElementById('mCancel').addEventListener('click', close);
  document.getElementById('backdrop').addEventListener('click', (e) => {
    if (e.target.id === 'backdrop') close();
  });

  document.getElementById('mUseLoc').addEventListener('click', () => {
    const hint = document.getElementById('mLocHint');
    if (!navigator.geolocation) {
      hint.textContent = 'Este navegador no soporta geolocalización';
      return;
    }
    hint.textContent = 'Buscando ubicación…';
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        document.getElementById('f-lat').value = pos.coords.latitude.toFixed(6);
        document.getElementById('f-lng').value = pos.coords.longitude.toFixed(6);
        hint.textContent = `Listo (precisión ±${Math.round(pos.coords.accuracy)} m)`;
      },
      (err) => {
        hint.textContent = `No se pudo obtener la ubicación: ${err.message}`;
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });

  document.getElementById('mSave').addEventListener('click', async () => {
    const lat = document.getElementById('f-lat').value.trim();
    const lng = document.getElementById('f-lng').value.trim();
    const body = {
      name: document.getElementById('f-name').value.trim(),
      location: document.getElementById('f-loc').value.trim(),
      description: document.getElementById('f-desc').value.trim(),
      lat: lat === '' ? null : Number(lat),
      lng: lng === '' ? null : Number(lng),
      ownerId: document.getElementById('f-owner').value || null,
      pricePerKwh: document.getElementById('f-price').value === '' ? null : Number(document.getElementById('f-price').value),
    };
    const errEl = document.getElementById('mErr');
    try {
      if (isEdit) {
        await api(`/api/chargers/${encodeURIComponent(charger.chargerId)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } else {
        body.chargerId = document.getElementById('f-cid').value.trim();
        await api('/api/chargers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      }
      close();
      load();
    } catch (e) {
      errEl.textContent = e.message;
    }
  });
}

document.getElementById('addBtn').addEventListener('click', () => openModal(null));

mountUserMenu(document.getElementById('userMenu'));
load();
loadSummary();
setInterval(load, 2000);
setInterval(loadSummary, 10000);
