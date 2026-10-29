'use strict';

const crypto = require('crypto');
const config = require('./config');
const db = require('./database');

/**
 * Login del panel: admin (el equipo de CargaCerca) y anfitrión (dueño de
 * cargadores). Sin dependencias: contraseñas con scrypt de node:crypto y
 * sesión en una cookie HttpOnly cuyo hash vive en SQLite (auth_sessions).
 *
 * La cookie es SameSite=Lax: el navegador no la manda en POST/PUT/DELETE
 * que vengan de otro sitio, y eso alcanza como protección CSRF para una API
 * que solo acepta JSON.
 *
 * Los endpoints del ESP32 y del conductor (mapa, vista cliente) NO pasan por
 * acá: siguen abiertos.
 */

const COOKIE = 'cc_session';

const q = {
  userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  userById: db.prepare('SELECT * FROM users WHERE id = ?'),
  insertUser: db.prepare(`
    INSERT INTO users (email, name, role, password_hash, is_demo, created_at)
    VALUES (@email, @name, @role, @password_hash, @is_demo, @created_at)
  `),
  setPassword: db.prepare('UPDATE users SET password_hash = ? WHERE id = ?'),
  listUsers: db.prepare(`
    SELECT u.*, (SELECT COUNT(*) FROM chargers c WHERE c.owner_id = u.id) AS chargers
      FROM users u ORDER BY u.role, u.name
  `),
  insertSession: db.prepare(
    'INSERT INTO auth_sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
  ),
  sessionUser: db.prepare(`
    SELECT u.* FROM auth_sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?
  `),
  deleteSession: db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?'),
  purgeSessions: db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?'),
};

// ---- Contraseñas ----
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

/** Lo que se le muestra al front de un usuario (nunca el hash). */
function userToPublic(u) {
  return { id: u.id, email: u.email, name: u.name, role: u.role, isDemo: !!u.is_demo };
}

/** Crea un usuario. Devuelve { user } o { error, status }. */
function createUser({ email, name, role, password, isDemo = false }) {
  email = String(email || '').trim().toLowerCase();
  name = String(name || '').trim().slice(0, 80);
  if (!isEmail(email)) return { status: 400, error: 'Email inválido' };
  if (!name) return { status: 400, error: 'El nombre es obligatorio' };
  if (!['admin', 'anfitrion'].includes(role)) return { status: 400, error: 'Rol inválido' };
  if (String(password || '').length < 8) {
    return { status: 400, error: 'La contraseña tiene que tener al menos 8 caracteres' };
  }
  if (q.userByEmail.get(email)) return { status: 409, error: 'Ya existe un usuario con ese email' };
  const r = q.insertUser.run({
    email,
    name,
    role,
    password_hash: hashPassword(password),
    is_demo: isDemo ? 1 : 0,
    created_at: new Date().toISOString(),
  });
  return { user: q.userById.get(Number(r.lastInsertRowid)) };
}

const listUsers = () =>
  q.listUsers.all().map((u) => ({ ...userToPublic(u), chargers: u.chargers, createdAt: u.created_at }));

// ---- Freno a fuerza bruta (en memoria, por IP) ----
const failures = new Map(); // ip -> [timestamps]
function tooManyFailures(ip, now = Date.now()) {
  const recent = (failures.get(ip) || []).filter((t) => now - t < config.auth.failedLoginWindowMs);
  failures.set(ip, recent);
  return recent.length >= config.auth.maxFailedLogins;
}
const registerFailure = (ip) => failures.set(ip, [...(failures.get(ip) || []), Date.now()]);

/** Devuelve el usuario si email+contraseña son correctos, o un error. */
function checkLogin(ip, email, password) {
  if (tooManyFailures(ip)) {
    return { status: 429, error: 'Demasiados intentos. Esperá unos minutos y probá de nuevo.' };
  }
  const user = q.userByEmail.get(String(email || '').trim().toLowerCase());
  // Sin usuario igual verificamos contra un hash cualquiera, para que el
  // tiempo de respuesta no delate qué emails existen.
  const ok = verifyPassword(password, user ? user.password_hash : DUMMY_HASH) && !!user;
  if (!ok || user.is_demo) {
    registerFailure(ip);
    return { status: 401, error: 'Email o contraseña incorrectos' };
  }
  return { user };
}
const DUMMY_HASH = hashPassword(crypto.randomBytes(12).toString('hex'));

// ---- Sesiones / cookie ----
function startSession(req, res, user) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = new Date();
  const expires = new Date(now.getTime() + config.auth.sessionDays * 86400000);
  q.purgeSessions.run(now.toISOString());
  q.insertSession.run(sha256(token), user.id, now.toISOString(), expires.toISOString());
  res.setHeader(
    'Set-Cookie',
    `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Expires=${expires.toUTCString()}${req.secure ? '; Secure' : ''}`
  );
}

function readCookie(req) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return v.join('=');
  }
  return null;
}

function endSession(req, res) {
  const token = readCookie(req);
  if (token) q.deleteSession.run(sha256(token));
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/** Middleware: deja en req.user al usuario logueado (o null). */
function attachUser(req, _res, next) {
  const token = readCookie(req);
  req.user = token ? q.sessionUser.get(sha256(token), new Date().toISOString()) || null : null;
  next();
}

/** Para la API: 401 sin login, 403 con otro rol. */
const requireApi = (...roles) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Iniciá sesión para continuar' });
  if (roles.length && !roles.includes(req.user.role)) {
    return res.status(403).json({ error: 'No tenés permiso para esto' });
  }
  next();
};

/** Página de inicio de cada rol. */
const homeFor = (user) => (user.role === 'admin' ? '/admin' : '/anfitrion');

/** Para las páginas: sin login va a /login; con otro rol, a su propio inicio. */
const requirePage = (...roles) => (req, res, next) => {
  if (!req.user) return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
  if (roles.length && !roles.includes(req.user.role)) return res.redirect(homeFor(req.user));
  next();
};

/** El admin ve todo; el anfitrión, solo sus cargadores. */
const canAccessCharger = (user, charger) => !!user && !!charger && (user.role === 'admin' || charger.owner_id === user.id);

// ---- Usuarios iniciales ----
const DEMO_USERS = {
  admin: { email: 'admin@demo.cargacerca', name: 'Equipo CargaCerca', role: 'admin' },
  anfitrion: { email: 'anfitrion@demo.cargacerca', name: 'Lucía (anfitriona demo)', role: 'anfitrion' },
};

function seed() {
  const { adminEmail, adminPassword } = config.auth;
  if (adminEmail && adminPassword) {
    const existing = q.userByEmail.get(adminEmail.toLowerCase());
    if (existing) q.setPassword.run(hashPassword(adminPassword), existing.id);
    else {
      const r = createUser({ email: adminEmail, name: 'Admin', role: 'admin', password: adminPassword });
      if (r.error) console.warn(`[auth] No se pudo crear ADMIN_EMAIL: ${r.error}`);
    }
  }
  if (config.auth.demoLogin) {
    // Contraseña aleatoria que nadie conoce: las cuentas demo solo entran
    // por el botón de /login (y checkLogin las rechaza por email+clave).
    for (const u of Object.values(DEMO_USERS)) {
      if (!q.userByEmail.get(u.email)) {
        createUser({ ...u, password: crypto.randomBytes(18).toString('hex'), isDemo: true });
      }
    }
    console.log('[auth] Login demo habilitado (DEMO_LOGIN)');
  }
  if (!adminEmail && !config.auth.demoLogin) {
    console.warn('[auth] No hay ADMIN_EMAIL/ADMIN_PASSWORD ni login demo: nadie puede entrar al panel.');
  }
}

const demoUser = (role) => (DEMO_USERS[role] ? q.userByEmail.get(DEMO_USERS[role].email) : null);

module.exports = {
  attachUser,
  requireApi,
  requirePage,
  canAccessCharger,
  homeFor,
  checkLogin,
  startSession,
  endSession,
  createUser,
  listUsers,
  userToPublic,
  seed,
  demoUser,
};
