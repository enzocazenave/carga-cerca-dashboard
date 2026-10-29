'use strict';

const KIND = { conductor: 'Conductor', particular: 'Anfitrión particular', consorcio: 'Consorcio', comercio: 'Comercio' };

async function load() {
  const leads = await panelApi('/api/leads');
  const body = document.getElementById('leadsBody');
  if (!leads.length) {
    body.innerHTML = '<tr><td colspan="5" class="empty-cell">Todavía nadie dejó sus datos en la landing.</td></tr>';
    return;
  }
  body.innerHTML = leads
    .map(
      (l) => `
      <tr>
        <td>${new Date(l.createdAt).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' })}</td>
        <td>${KIND[l.kind] || panelEsc(l.kind)}</td>
        <td><b>${panelEsc(l.name)}</b></td>
        <td>${panelEsc(l.contact)}</td>
        <td>${panelEsc(l.zone || '—')}</td>
      </tr>`
    )
    .join('');
}

mountUserMenu(document.getElementById('userMenu'));
load();
