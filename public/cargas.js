'use strict';

// Historial de cargas de un cargador y reseñas del anfitrión al conductor
// (detalle del cargador, /chargers/:id). Se refresca solo, pero sin pisar
// una reseña a medio escribir: las tarjetas de reseña pendientes se agregan
// o se quitan, nunca se vuelven a dibujar. Va dentro de una función para no
// chocar con las constantes globales de detail.js.
(function () {
  const chargerId = decodeURIComponent(location.pathname.split('/').pop());
  // Mismo componente en los dos paneles: el anfitrión ve lo que le queda
  // (después de la comisión); el admin, la comisión de CargaCerca.
  const isHost = document.body.dataset.role === 'anfitrion';
  const $ = (id) => document.getElementById(id);
  const esc = (v) =>
    String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function fmtMoney(value, currency) {
    try {
      return new Intl.NumberFormat('es-AR', {
        style: 'currency',
        currency: currency || 'ARS',
        maximumFractionDigits: value < 100 ? 2 : 0,
      }).format(value);
    } catch {
      return `$ ${value.toFixed(2)}`;
    }
  }

  const num = (v, d) => v.toLocaleString('es-AR', { minimumFractionDigits: d, maximumFractionDigits: d });
  const fmtEnergy = (wh) => (wh >= 1000 ? `${num(wh / 1000, 2)} kWh` : `${num(wh, wh < 10 ? 2 : 0)} Wh`);

  function fmtDur(ms) {
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s} s`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m} min`;
    return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
  }

  function fmtFecha(iso) {
    const d = new Date(iso);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  const stars = (n) => '★'.repeat(n) + '☆'.repeat(5 - n);

  function repChip(driver) {
    if (!driver || !driver.reputation) return '';
    const rep = fmtReputation(driver.reputation);
    return rep ? `<span class="rep">${rep}</span>` : '<span class="rep new">Sin reseñas</span>';
  }

  // Energía con escala de demo: mostramos la cifra cobrada y, al pasar el
  // mouse, la medida real (ver DEMO_ENERGY_SCALE en config.js).
  function energyCell(s) {
    const title = s.energyScale !== 1 ? ` title="Medido ${num(s.energyWh, 4)} Wh × ${s.energyScale} (escala de demo)"` : '';
    return `<span${title}>${fmtEnergy(s.billedEnergyWh)}</span>`;
  }

  function renderStats(st) {
    $('cargasStats').innerHTML = `
      <div class="metric"><div class="label">Cargas</div><div class="big">${st.sessions}</div><div class="small">${fmtEnergy(st.billedEnergyWh)} entregados</div></div>
      <div class="metric"><div class="label">Cobrado a conductores</div><div class="big">${fmtMoney(st.amount, st.currency)}</div></div>
      ${isHost
        ? `<div class="metric"><div class="label">Tu ingreso</div><div class="big good">${fmtMoney(st.hostNet, st.currency)}</div></div>`
        : `<div class="metric"><div class="label">Comisión CargaCerca</div><div class="big">${fmtMoney(st.amount - st.hostNet, st.currency)}</div></div>`}
      <div class="metric"><div class="label">Reseñas pendientes</div><div class="big ${st.pendingReviews ? 'warn' : ''}">${st.pendingReviews}</div></div>`;
  }

  function renderTable(list) {
    if (!list.length) {
      $('sessionsBody').innerHTML = '<tr><td colspan="7" class="empty-cell">Todavía no hubo cargas en este cargador.</td></tr>';
      return;
    }
    $('sessionsBody').innerHTML = list
      .map((s) => {
        const driver = s.driver
          ? `<b>${esc(s.driver.name)}</b>${repChip(s.driver)}`
          : '<span class="muted">Sin identificar</span>';
        let review = '<span class="muted">—</span>';
        if (s.review) {
          review = `<span class="stars-static" title="${esc(s.review.comment || '')}">${stars(s.review.rating)}</span>`;
        } else if (s.reviewable) {
          review = `<a class="pill-warn" href="#review-${s.id}">Reseñar</a>`;
        }
        return `
          <tr>
            <td>${fmtFecha(s.startedAt)}${s.endedAt ? '' : ' <span class="pill-live">en curso</span>'}</td>
            <td>${driver}</td>
            <td>${fmtDur(s.durationMs)}</td>
            <td>${energyCell(s)}</td>
            <td>${fmtMoney(s.amount, s.currency)}</td>
            <td><b>${fmtMoney(isHost ? s.hostNet : s.amount - s.hostNet, s.currency)}</b></td>
            <td>${review}</td>
          </tr>`;
      })
      .join('');
  }

  function reviewCard(s) {
    const el = document.createElement('form');
    el.className = 'review-card';
    el.id = `review-${s.id}`;
    el.dataset.review = s.id;
    const name = esc(s.driver.name);
    // Estrellas como radios (accesibles con teclado). Van de 5 a 1 en el DOM
    // y se dan vuelta con CSS, así "~" pinta las anteriores al hover/checked.
    const radios = [5, 4, 3, 2, 1]
      .map(
        (n) => `<input type="radio" id="r${s.id}-${n}" name="rating" value="${n}" required />` +
          `<label for="r${s.id}-${n}" title="${n} de 5">★</label>`
      )
      .join('');
    el.innerHTML = `
      <div class="rc-head">
        <div><b>Terminó la carga de ${name}</b> ${repChip(s.driver)}</div>
        <span class="rc-meta">${fmtFecha(s.startedAt)} · ${fmtDur(s.durationMs)} · ${fmtEnergy(s.billedEnergyWh)} · ${fmtMoney(s.amount, s.currency)}</span>
      </div>
      <fieldset class="rc-stars"><legend>¿Cómo fue la carga con ${name}?</legend><div class="stars-input">${radios}</div></fieldset>
      <textarea name="comment" maxlength="280" rows="2" placeholder="Comentario opcional. Ayuda a otros anfitriones a conocerlo."></textarea>
      <div class="rc-actions"><span class="rc-err" role="status"></span><button class="btn" type="submit">Guardar reseña</button></div>`;

    el.addEventListener('submit', async (e) => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(el));
      const err = el.querySelector('.rc-err');
      if (!data.rating) {
        err.textContent = 'Elegí de 1 a 5 estrellas';
        return;
      }
      const btn = el.querySelector('button');
      btn.disabled = true;
      err.textContent = '';
      try {
        await panelApi(`/api/sessions/${s.id}/review`, panelJson('POST', { rating: Number(data.rating), comment: data.comment }));
        el.remove();
        refresh(true);
      } catch (ex) {
        err.textContent = ex.message;
        btn.disabled = false;
      }
    });
    return el;
  }

  function renderQueue(pending, isFirstLoad) {
    const queue = $('reviewQueue');
    const wanted = new Set(pending.map((s) => String(s.id)));
    queue.querySelectorAll('[data-review]').forEach((el) => {
      if (!wanted.has(el.dataset.review)) el.remove();
    });
    // pending viene de la más nueva a la más vieja: insertando al principio
    // desde la más vieja, la más nueva queda arriba de todo.
    pending
      .slice()
      .reverse()
      .forEach((s) => {
        if (queue.querySelector(`[data-review="${s.id}"]`)) return;
        const card = reviewCard(s);
        if (!isFirstLoad) card.classList.add('fresh'); // terminó mientras mirabas
        queue.prepend(card);
      });
  }

  let lastKey = null;

  async function refresh(force) {
    let data;
    try {
      data = await panelApi(`/api/chargers/${encodeURIComponent(chargerId)}/sessions?limit=100`);
    } catch {
      return;
    }
    renderStats(data.stats);
    const key = JSON.stringify(data.sessions.map((s) => [s.id, s.endedAt, s.amount, !!s.review]));
    if (key === lastKey && !force) return;
    const isFirstLoad = lastKey === null;
    lastKey = key;
    renderTable(data.sessions);
    renderQueue(data.sessions.filter((s) => s.reviewable), isFirstLoad);
    // Link "Reseñar" desde otra página (#review-123): la tarjeta recién existe ahora.
    if (isFirstLoad && location.hash.startsWith('#review-')) {
      const target = document.querySelector(location.hash);
      if (target) {
        target.scrollIntoView({ block: 'center' });
        target.classList.add('fresh');
      }
    }
    $('scaleNote').hidden = !data.sessions.some((s) => s.energyScale !== 1);
  }

  refresh();
  setInterval(refresh, 3000);
})();
