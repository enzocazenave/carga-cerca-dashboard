'use strict';

// Helpers compartidos por los paneles con login (admin y anfitrión).
// Nombres con prefijo para no chocar con los globales de list.js/detail.js.

/** fetch a la API del panel: si la sesión venció, vuelve a /login. */
async function panelApi(path, opts) {
  const res = await fetch(path, opts);
  if (res.status === 401) {
    location.href = `/login?next=${encodeURIComponent(location.pathname)}`;
    throw new Error('Tu sesión venció');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

const panelJson = (method, body) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

function panelEsc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function panelMoney(value, currency) {
  try {
    return new Intl.NumberFormat('es-AR', {
      style: 'currency',
      currency: currency || 'ARS',
      maximumFractionDigits: Math.abs(value) < 100 ? 2 : 0,
    }).format(value);
  } catch {
    return `$ ${Number(value).toFixed(2)}`;
  }
}

function panelEnergy(wh) {
  const n = (v, d) => v.toLocaleString('es-AR', { minimumFractionDigits: d, maximumFractionDigits: d });
  return wh >= 1000 ? `${n(wh / 1000, 2)} kWh` : `${n(wh, wh < 10 ? 2 : 0)} Wh`;
}

/** Nombre del usuario + "Salir", en el header. Devuelve el usuario. */
async function mountUserMenu(el) {
  const { user } = await panelApi('/api/auth/me');
  if (!user) {
    location.href = `/login?next=${encodeURIComponent(location.pathname)}`;
    return null;
  }
  el.innerHTML =
    `<span class="um-name">${panelEsc(user.name)}${user.isDemo ? ' <span class="um-demo">demo</span>' : ''}</span>` +
    '<button class="btn link" type="button">Salir</button>';
  el.querySelector('button').addEventListener('click', async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    location.href = '/login';
  });
  return user;
}

// Estado del cargador en lenguaje de anfitrión: [clase del punto, texto].
const PANEL_STATUS = {
  'Cargando': ['charging', 'Cargando'],
  'Consumo bajo': ['low', 'Carga lenta'],
  'Disponible': ['available', 'Libre'],
  'Esperando tarjeta': ['available', 'Libre'],
  'Tarjeta leída · esperando inicio': ['waiting-start', 'Por empezar a cargar'],
  'Carga finalizada': ['available', 'Libre'],
  'Desconectado': ['disconnected', 'Sin conexión'],
  'Nunca conectado': ['never', 'Sin datos todavía'],
};
const panelStatus = (s) => PANEL_STATUS[s] || PANEL_STATUS['Nunca conectado'];
