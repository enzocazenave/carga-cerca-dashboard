'use strict';

// ---- Videos de marca ----
// Arrancan (mudos, en loop) solo cuando están en pantalla y se pausan al
// salir, así la landing no baja los tres videos de entrada (preload="none").
// Con "reducir movimiento" no hay autoplay: quedan los controles nativos.
const videos = document.querySelectorAll('video[data-autoplay]');
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

if (reduceMotion || !('IntersectionObserver' in window)) {
  videos.forEach((v) => (v.controls = true));
} else {
  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach(({ target, isIntersecting }) => {
        if (isIntersecting) target.play().catch(() => (target.controls = true));
        else target.pause();
      });
    },
    { threshold: 0.4 }
  );
  videos.forEach((v) => io.observe(v));
}

// ---- Formulario de interesados ----
const form = document.getElementById('leadForm');
const msg = document.getElementById('leadMsg');
const btn = document.getElementById('leadBtn');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(form));

  if (!data.name.trim() || !data.contact.trim()) {
    msg.className = 'form-msg err';
    msg.textContent = 'Completá tu nombre y un email o WhatsApp';
    (data.name.trim() ? form.contact : form.name).focus();
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Enviando…';
  msg.className = 'form-msg';
  msg.textContent = '';

  try {
    const res = await fetch('/api/leads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || 'No pudimos enviar tus datos. Probá de nuevo.');
    document.getElementById('leadFields').hidden = true;
    document.getElementById('leadDone').hidden = false;
  } catch (err) {
    msg.className = 'form-msg err';
    msg.textContent = err.message;
    btn.disabled = false;
    btn.textContent = 'Quiero sumarme';
  }
});
