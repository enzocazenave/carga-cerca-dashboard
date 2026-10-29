'use strict';

const err = document.getElementById('err');

// Solo rutas internas: un ?next=https://otro-sitio no debe redirigir afuera.
function destino(home) {
  const next = new URLSearchParams(location.search).get('next');
  return next && next.startsWith('/') && !next.startsWith('//') ? next : home;
}

async function entrar(url, body, btn) {
  btn.disabled = true;
  err.textContent = '';
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'No pudimos iniciar sesión');
    // Un ?next de otro rol terminaría redirigiendo igual a su inicio (ver
    // requirePage), así que lo usamos solo si es del mismo panel.
    const next = destino(data.home);
    location.href = next.startsWith(data.home) || (data.home === '/admin' && next.startsWith('/chargers/')) ? next : data.home;
  } catch (e) {
    err.textContent = e.message;
    btn.disabled = false;
  }
}

document.getElementById('loginForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;
  if (!email || !password) {
    err.textContent = 'Completá tu email y contraseña';
    return;
  }
  entrar('/api/auth/login', { email, password }, document.getElementById('loginBtn'));
});

fetch('/api/auth/me')
  .then((r) => r.json())
  .then(({ demoLogin }) => {
    if (!demoLogin) return;
    document.getElementById('demo').hidden = false;
    document.querySelectorAll('[data-demo]').forEach((b) =>
      b.addEventListener('click', () => entrar('/api/auth/demo', { role: b.dataset.demo }, b))
    );
  });
