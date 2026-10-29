'use strict';

const config = require('./config');
const db = require('./database');

/**
 * Conductores y su reputación (reseñas que les dejan los anfitriones al
 * terminar cada carga). No hay login: el conductor se identifica con un id
 * anónimo que genera su navegador (ver public/conductor.js).
 */

// Lo genera el navegador (crypto.randomUUID o un fallback): letras, números
// y guiones. Validarlo evita guardar cualquier cosa como clave.
const DRIVER_ID_RE = /^[A-Za-z0-9-]{16,64}$/;

const q = {
  upsert: db.prepare(`
    INSERT INTO drivers (id, name, created_at, updated_at)
    VALUES (@id, @name, @now, @now)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at
  `),
  get: db.prepare('SELECT * FROM drivers WHERE id = ?'),
  reputation: db.prepare(
    'SELECT COUNT(*) AS count, AVG(rating) AS avg FROM driver_reviews WHERE driver_id = ?'
  ),
  recentReviews: db.prepare(`
    SELECT r.rating, r.comment, r.created_at, c.name AS charger_name
      FROM driver_reviews r
      LEFT JOIN chargers c ON c.charger_id = r.charger_id
     WHERE r.driver_id = ?
     ORDER BY r.created_at DESC
     LIMIT ?
  `),
  insertReview: db.prepare(`
    INSERT INTO driver_reviews (session_id, driver_id, charger_id, rating, comment, created_at)
    VALUES (@session_id, @driver_id, @charger_id, @rating, @comment, @created_at)
  `),
  reviewForSession: db.prepare('SELECT id FROM driver_reviews WHERE session_id = ?'),
};

const isValidId = (id) => typeof id === 'string' && DRIVER_ID_RE.test(id);

/** Crea o actualiza al conductor (el nombre puede cambiar entre cargas). */
function upsert(id, name) {
  q.upsert.run({ id, name, now: new Date().toISOString() });
}

/** { rating: 4.7, count: 3 }, o rating null si todavía no tiene reseñas. */
function reputationOf(id) {
  const r = q.reputation.get(id);
  return { rating: r.count ? Math.round(r.avg * 10) / 10 : null, count: r.count };
}

function profile(id) {
  const d = q.get.get(id);
  if (!d) return null;
  return {
    name: d.name,
    memberSince: d.created_at,
    reputation: reputationOf(id),
    recentReviews: q.recentReviews.all(id, 5).map((r) => ({
      rating: r.rating,
      comment: r.comment,
      chargerName: r.charger_name,
      createdAt: r.created_at,
    })),
  };
}

/**
 * Reseña del anfitrión para una sesión terminada. Devuelve { error, status }
 * si no se puede, o { ok: true }.
 */
function reviewSession(session, rating, comment) {
  if (!session) return { status: 404, error: 'La carga no existe' };
  if (!session.ended_at) return { status: 409, error: 'La carga todavía no terminó' };
  if (!session.driver_id) {
    return { status: 409, error: 'Esta carga no tiene un conductor identificado para reseñar' };
  }
  if (q.reviewForSession.get(session.id)) return { status: 409, error: 'Esta carga ya tiene reseña' };

  const r = Number(rating);
  if (!Number.isInteger(r) || r < 1 || r > 5) {
    return { status: 400, error: 'La calificación va de 1 a 5 estrellas' };
  }

  q.insertReview.run({
    session_id: session.id,
    driver_id: session.driver_id,
    charger_id: session.charger_id,
    rating: r,
    comment: String(comment || '').trim().slice(0, config.reviews.maxCommentLength) || null,
    created_at: new Date().toISOString(),
  });
  return { ok: true };
}

module.exports = { isValidId, upsert, reputationOf, profile, reviewSession };
