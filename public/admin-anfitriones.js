'use strict';

const $ = (id) => document.getElementById(id);

function fmtFecha(iso) {
  return new Date(iso).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

async function load() {
  const users = await panelApi('/api/users');
  $('usersBody').innerHTML = users
    .map(
      (u) => `
      <tr>
        <td><b>${panelEsc(u.name)}</b>${u.isDemo ? ' <span class="um-demo">demo</span>' : ''}</td>
        <td>${panelEsc(u.email)}</td>
        <td>${u.role === 'admin' ? 'Admin' : 'Anfitrión'}</td>
        <td>${u.role === 'admin' ? '<span class="muted">—</span>' : u.chargers}</td>
        <td>${fmtFecha(u.createdAt)}</td>
      </tr>`
    )
    .join('');
}

// Contraseña inicial legible para dictar o pegar (sin 0/O, 1/l).
$('uGen').addEventListener('click', () => {
  const abc = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  $('uPass').value = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => abc[b % abc.length]).join('');
});

$('userForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = { name: $('uName').value.trim(), email: $('uEmail').value.trim(), password: $('uPass').value };
  $('uErr').textContent = '';
  try {
    const u = await panelApi('/api/users', panelJson('POST', body));
    $('uDone').hidden = false;
    $('uDone').innerHTML =
      `Listo. Pasale a <b>${panelEsc(u.name)}</b> estos datos para entrar en <code>${panelEsc(location.origin)}/login</code><br>` +
      `Email <code>${panelEsc(u.email)}</code><br>Contraseña <code>${panelEsc(body.password)}</code><br>` +
      'Después asignale sus cargadores desde Cargadores, botón Editar.';
    $('userForm').querySelectorAll('input').forEach((i) => (i.value = ''));
    load();
  } catch (ex) {
    $('uErr').textContent = ex.message;
  }
});

mountUserMenu($('userMenu'));
load();
