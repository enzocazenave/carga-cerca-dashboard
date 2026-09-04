'use strict';

const listEl = document.getElementById('list');
const emptyEl = document.getElementById('empty');
const modalRoot = document.getElementById('modalRoot');

const STATUS_CLASS = {
  'Cargando': 'charging',
  'Consumo bajo': 'low',
  'Disponible': 'available',
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

async function api(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

async function load() {
  let chargers;
  try {
    chargers = await api('/api/chargers');
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
        </a>
        <div class="card-actions">
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

function openModal(charger) {
  const isEdit = !!charger;
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
        <div class="field">
          <label>Ubicación</label>
          <input id="f-loc" value="${esc(charger?.location || '')}" />
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

  document.getElementById('mSave').addEventListener('click', async () => {
    const body = {
      name: document.getElementById('f-name').value.trim(),
      location: document.getElementById('f-loc').value.trim(),
      description: document.getElementById('f-desc').value.trim(),
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

load();
setInterval(load, 2000);
