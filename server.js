// Hidden Magic — marché MTG pour Rouyn-Noranda.
// Serveur Express unique : API + fichiers statiques (public/).
// Base de données : Turso (libsql) en production, fichier libsql local sinon.
// Aucun paiement en ligne : les échanges se concluent en personne.
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { createClient } = require('@libsql/client');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT || 3000);
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me';
const IS_PROD = process.env.NODE_ENV === 'production';
const MAX_PHOTO_CHARS = 700_000; // ~500 Ko d'image encodée en base64
const SESSION_DAYS = 30;

const db = (() => {
  const url = (process.env.TURSO_DATABASE_URL || '').trim();
  if (url) {
    console.log('Base de données : Turso');
    return createClient({
      url,
      authToken: (process.env.TURSO_AUTH_TOKEN || '').trim() || undefined,
    });
  }
  const dataDir = path.join(__dirname, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  console.log('Base de données : fichier local ./data/hidden-magic.db');
  return createClient({ url: `file:${path.join(dataDir, 'hidden-magic.db')}` });
})();

// ---------------------------------------------------------------------------
// Schéma (créé au démarrage si absent)
// ---------------------------------------------------------------------------
async function initDb() {
  await db.executeMultiple(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      is_admin INTEGER NOT NULL DEFAULT 0,
      is_blocked INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS listings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      title TEXT NOT NULL,
      edition TEXT NOT NULL,
      condition TEXT NOT NULL,
      price_cents INTEGER NOT NULL,
      language TEXT NOT NULL DEFAULT 'FR',
      foil INTEGER NOT NULL DEFAULT 0,
      photo TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
      buyer_id INTEGER NOT NULL REFERENCES users(id),
      seller_id INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL,
      UNIQUE (listing_id, buyer_id)
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      sender_id INTEGER NOT NULL REFERENCES users(id),
      body TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reporter_id INTEGER NOT NULL REFERENCES users(id),
      target_type TEXT NOT NULL,
      target_id INTEGER NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      UNIQUE (reporter_id, target_type, target_id)
    );
    CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(status);
    CREATE INDEX IF NOT EXISTS idx_listings_title ON listings(title);
    CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);
    CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id);
  `);
}

const nowIso = () => new Date().toISOString();
const CONDITIONS = ['Neuf', 'Comme neuf', 'Excellent', 'Bon', 'Usé'];

// ---------------------------------------------------------------------------
// Mots de passe (scrypt + sel aléatoire, sans dépendance native)
// ---------------------------------------------------------------------------
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(candidate, 'hex'));
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------
function newToken() {
  return crypto.randomBytes(32).toString('hex');
}
async function createSession(userId) {
  const token = newToken();
  const created = new Date();
  const expires = new Date(created.getTime() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await db.execute({
    sql: 'INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
    args: [token, userId, created.toISOString(), expires.toISOString()],
  });
  return token;
}
function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PROD,
    path: '/',
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
  };
}

// ---------------------------------------------------------------------------
// Application Express
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false }));

// Petit durcissement des en-têtes (sans dépendance helmet).
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

// Résout l'utilisateur courant à partir du cookie de session.
async function loadUser(req) {
  const token = req.cookies?.hm_session;
  if (!token) return null;
  const row = await db.execute({
    sql: `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.token = ? AND s.expires_at > ?`,
    args: [token, nowIso()],
  });
  return row.rows[0] || null;
}

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    is_admin: !!u.is_admin,
    is_blocked: !!u.is_blocked,
    created_at: u.created_at,
  };
}

function parseCookies(req, res, next) {
  const header = req.headers.cookie || '';
  req.cookies = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) req.cookies[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  next();
}
app.use(parseCookies);

async function requireAuth(req, res, next) {
  try {
    const user = await loadUser(req);
    if (!user) return res.status(401).json({ error: 'Connexion requise.' });
    req.user = user;
    next();
  } catch (e) {
    next(e);
  }
}

function requireAdmin(req, res, next) {
  if (!req.user.is_admin) {
    return res.status(403).json({ error: 'Espace réservé à l’administrateur.' });
  }
  next();
}

// Garde-fou : un compte bloqué ne peut pas publier, contacter ni écrire.
function requireNotBlocked(req, res, next) {
  if (req.user.is_blocked) {
    return res.status(403).json({
      error: 'Votre compte est bloqué par l’administrateur. Vous ne pouvez plus publier d’annonces ni envoyer de messages.',
    });
  }
  next();
}

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// Identifiant numérique d'URL valide, ou null.
function paramId(req) {
  const n = Number(req.params.id);
  return Number.isInteger(n) ? n : null;
}

// Suppression d'une annonce et de tout ce qui s'y rattache
// (conversations et messages liés — la base locale comme Turso
// n'activent pas forcément les cascades de clés étrangères).
async function deleteListingCascade(listingId) {
  const convs = await db.execute({ sql: 'SELECT id FROM conversations WHERE listing_id = ?', args: [listingId] });
  for (const c of convs.rows) {
    await db.execute({ sql: 'DELETE FROM messages WHERE conversation_id = ?', args: [c.id] });
  }
  await db.execute({ sql: 'DELETE FROM conversations WHERE listing_id = ?', args: [listingId] });
  await db.execute({ sql: 'DELETE FROM listings WHERE id = ?', args: [listingId] });
}

const api = express.Router();
app.use('/api', api);

// ---------------------------------------------------------------------------
// Authentification
// ---------------------------------------------------------------------------
api.post('/auth/register', asyncHandler(async (req, res) => {
  const username = String(req.body?.username || '').trim();
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (username.length < 3 || username.length > 30 || !/^[A-Za-z0-9 _\-.àâäéèêëîïôöùûüç]+$/.test(username)) {
    return res.status(400).json({ error: 'Le nom d’utilisateur doit contenir de 3 à 30 caractères (lettres, chiffres, espaces, tirets).' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Adresse courriel invalide.' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 8 caractères.' });
  }
  const count = await db.execute('SELECT COUNT(*) AS n FROM users');
  const isFirst = Number(count.rows[0].n) === 0;
  try {
    const r = await db.execute({
      sql: 'INSERT INTO users (username, email, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?)',
      args: [username, email, hashPassword(password), isFirst ? 1 : 0, nowIso()],
    });
    const token = await createSession(Number(r.lastInsertRowid));
    res.cookie('hm_session', token, sessionCookieOptions());
    const user = await db.execute({ sql: 'SELECT * FROM users WHERE id = ?', args: [Number(r.lastInsertRowid)] });
    res.status(201).json({ user: publicUser(user.rows[0]), is_admin: isFirst });
  } catch (e) {
    if (String(e.message || '').includes('UNIQUE')) {
      return res.status(409).json({ error: 'Ce nom d’utilisateur ou ce courriel est déjà utilisé.' });
    }
    throw e;
  }
}));

api.post('/auth/login', asyncHandler(async (req, res) => {
  const login = String(req.body?.login || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (!login || !password) return res.status(400).json({ error: 'Identifiant et mot de passe requis.' });
  const row = await db.execute({
    sql: 'SELECT * FROM users WHERE lower(username) = ? OR lower(email) = ?',
    args: [login, login],
  });
  const user = row.rows[0];
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'Identifiant ou mot de passe incorrect.' });
  }
  const token = await createSession(user.id);
  res.cookie('hm_session', token, sessionCookieOptions());
  res.json({ user: publicUser(user) });
}));

api.post('/auth/logout', asyncHandler(async (req, res) => {
  const token = req.cookies?.hm_session;
  if (token) await db.execute({ sql: 'DELETE FROM sessions WHERE token = ?', args: [token] });
  res.clearCookie('hm_session', { path: '/' });
  res.json({ ok: true });
}));

api.get('/auth/me', asyncHandler(async (req, res) => {
  const user = await loadUser(req);
  res.json({ user: publicUser(user) });
}));

// ---------------------------------------------------------------------------
// Annonces
// ---------------------------------------------------------------------------
function listingView(r) {
  return {
    id: r.id,
    user_id: r.user_id,
    seller: r.seller,
    title: r.title,
    edition: r.edition,
    condition: r.condition,
    price_cents: r.price_cents,
    price: (r.price_cents / 100).toFixed(2),
    language: r.language,
    foil: !!r.foil,
    photo: r.photo || null,
    status: r.status,
    created_at: r.created_at,
    report_count: r.report_count != null ? Number(r.report_count) : undefined,
  };
}

const LISTING_SELECT = `
  SELECT l.*, u.username AS seller
  FROM listings l JOIN users u ON u.id = l.user_id`;

api.get('/listings', asyncHandler(async (req, res) => {
  const q = String(req.query.q || '').trim();
  const condition = String(req.query.condition || '').trim();
  const mine = req.query.mine === '1';
  const where = ["l.status = 'active'"];
  const args = [];
  if (q) {
    where.push('(l.title LIKE ? OR l.edition LIKE ? OR u.username LIKE ?)');
    const like = `%${q}%`;
    args.push(like, like, like);
  }
  if (condition && CONDITIONS.includes(condition)) {
    where.push('l.condition = ?');
    args.push(condition);
  }
  if (mine) {
    const user = await loadUser(req);
    if (!user) return res.status(401).json({ error: 'Connexion requise.' });
    where.push('l.user_id = ?');
    args.push(user.id);
  }
  const rows = await db.execute({
    sql: `${LISTING_SELECT} WHERE ${where.join(' AND ')} ORDER BY l.created_at DESC LIMIT 200`,
    args,
  });
  res.json({ listings: rows.rows.map(listingView) });
}));

api.get('/listings/:id', asyncHandler(async (req, res) => {
  const id = paramId(req);
  if (id === null) return res.status(400).json({ error: 'Annonce invalide.' });
  const rows = await db.execute({ sql: `${LISTING_SELECT} WHERE l.id = ?`, args: [id] });
  if (!rows.rows[0]) return res.status(404).json({ error: 'Annonce introuvable.' });
  res.json({ listing: listingView(rows.rows[0]) });
}));

api.post('/listings', requireAuth, requireNotBlocked, asyncHandler(async (req, res) => {
  const title = String(req.body?.title || '').trim();
  const edition = String(req.body?.edition || '').trim();
  const condition = String(req.body?.condition || '').trim();
  const language = String(req.body?.language || 'FR').toUpperCase() === 'EN' ? 'EN' : 'FR';
  const foil = req.body?.foil ? 1 : 0;
  const photo = typeof req.body?.photo === 'string' ? req.body.photo : null;
  const priceRaw = String(req.body?.price || '').trim().replace(',', '.');
  const price = Number(priceRaw);
  if (title.length < 2 || title.length > 120) return res.status(400).json({ error: 'Le nom de la carte est requis (2 à 120 caractères).' });
  if (edition.length < 1 || edition.length > 120) return res.status(400).json({ error: 'L’édition est requise.' });
  if (!CONDITIONS.includes(condition)) return res.status(400).json({ error: 'État invalide.' });
  if (!Number.isFinite(price) || price < 0 || price > 100000) return res.status(400).json({ error: 'Prix invalide (en dollars canadiens).' });
  if (photo) {
    if (!/^data:image\/(jpeg|png|webp);base64,/.test(photo)) {
      return res.status(400).json({ error: 'La photo doit être une image JPEG, PNG ou WebP.' });
    }
    if (photo.length > MAX_PHOTO_CHARS) {
      return res.status(400).json({ error: 'La photo est trop lourde. Choisissez une image plus petite.' });
    }
  }
  const r = await db.execute({
    sql: `INSERT INTO listings (user_id, title, edition, condition, price_cents, language, foil, photo, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [req.user.id, title, edition, condition, Math.round(price * 100), language, foil, photo, nowIso()],
  });
  const rows = await db.execute({ sql: `${LISTING_SELECT} WHERE l.id = ?`, args: [Number(r.lastInsertRowid)] });
  res.status(201).json({ listing: listingView(rows.rows[0]) });
}));

api.patch('/listings/:id/sold', requireAuth, asyncHandler(async (req, res) => {
  const id = paramId(req);
  if (id === null) return res.status(400).json({ error: 'Annonce invalide.' });
  const rows = await db.execute({ sql: 'SELECT * FROM listings WHERE id = ?', args: [id] });
  const listing = rows.rows[0];
  if (!listing) return res.status(404).json({ error: 'Annonce introuvable.' });
  if (listing.user_id !== req.user.id && !req.user.is_admin) {
    return res.status(403).json({ error: 'Vous ne pouvez modifier que vos propres annonces.' });
  }
  const status = req.body?.status === 'active' ? 'active' : 'sold';
  await db.execute({ sql: 'UPDATE listings SET status = ? WHERE id = ?', args: [status, listing.id] });
  const updated = await db.execute({ sql: `${LISTING_SELECT} WHERE l.id = ?`, args: [listing.id] });
  res.json({ listing: listingView(updated.rows[0]) });
}));

api.delete('/listings/:id', requireAuth, asyncHandler(async (req, res) => {
  const id = paramId(req);
  if (id === null) return res.status(400).json({ error: 'Annonce invalide.' });
  const rows = await db.execute({ sql: 'SELECT * FROM listings WHERE id = ?', args: [id] });
  const listing = rows.rows[0];
  if (!listing) return res.status(404).json({ error: 'Annonce introuvable.' });
  if (listing.user_id !== req.user.id && !req.user.is_admin) {
    return res.status(403).json({ error: 'Vous ne pouvez supprimer que vos propres annonces.' });
  }
  await deleteListingCascade(listing.id);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Messagerie privée
// ---------------------------------------------------------------------------
async function getConversationForUser(convId, userId) {
  const rows = await db.execute({
    sql: `SELECT c.*, l.title AS listing_title, l.price_cents, l.status AS listing_status,
                 b.username AS buyer_name, s.username AS seller_name
          FROM conversations c
          JOIN listings l ON l.id = c.listing_id
          JOIN users b ON b.id = c.buyer_id
          JOIN users s ON s.id = c.seller_id
          WHERE c.id = ? AND (c.buyer_id = ? OR c.seller_id = ?)`,
    args: [convId, userId, userId],
  });
  return rows.rows[0] || null;
}

api.get('/conversations', requireAuth, asyncHandler(async (req, res) => {
  const rows = await db.execute({
    sql: `SELECT c.*, l.title AS listing_title, l.price_cents, l.status AS listing_status,
                 l.photo AS listing_photo,
                 b.username AS buyer_name, s.username AS seller_name,
                 (SELECT body FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_body,
                 (SELECT created_at FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_at
          FROM conversations c
          JOIN listings l ON l.id = c.listing_id
          JOIN users b ON b.id = c.buyer_id
          JOIN users s ON s.id = c.seller_id
          WHERE c.buyer_id = ? OR c.seller_id = ?
          ORDER BY COALESCE(last_at, c.created_at) DESC`,
    args: [req.user.id, req.user.id],
  });
  res.json({
    conversations: rows.rows.map((c) => ({
      id: c.id,
      listing_id: c.listing_id,
      listing_title: c.listing_title,
      listing_price: (c.price_cents / 100).toFixed(2),
      listing_status: c.listing_status,
      listing_photo: c.listing_photo || null,
      buyer_id: c.buyer_id,
      buyer_name: c.buyer_name,
      seller_id: c.seller_id,
      seller_name: c.seller_name,
      other_name: c.buyer_id === req.user.id ? c.seller_name : c.buyer_name,
      other_id: c.buyer_id === req.user.id ? c.seller_id : c.buyer_id,
      last_body: c.last_body || null,
      last_at: c.last_at || c.created_at,
      created_at: c.created_at,
    })),
  });
}));

api.post('/conversations', requireAuth, requireNotBlocked, asyncHandler(async (req, res) => {
  const listingId = Number(req.body?.listing_id);
  if (!Number.isInteger(listingId)) return res.status(400).json({ error: 'Annonce invalide.' });
  const rows = await db.execute({ sql: 'SELECT * FROM listings WHERE id = ?', args: [listingId] });
  const listing = rows.rows[0];
  if (!listing || listing.status !== 'active') {
    return res.status(404).json({ error: 'Annonce introuvable ou vendue.' });
  }
  if (listing.user_id === req.user.id) {
    return res.status(400).json({ error: 'Vous ne pouvez pas vous écrire à vous-même.' });
  }
  const existing = await db.execute({
    sql: 'SELECT id FROM conversations WHERE listing_id = ? AND buyer_id = ?',
    args: [listingId, req.user.id],
  });
  if (existing.rows[0]) return res.json({ conversation_id: existing.rows[0].id, existing: true });
  const r = await db.execute({
    sql: 'INSERT INTO conversations (listing_id, buyer_id, seller_id, created_at) VALUES (?, ?, ?, ?)',
    args: [listingId, req.user.id, listing.user_id, nowIso()],
  });
  res.status(201).json({ conversation_id: Number(r.lastInsertRowid), existing: false });
}));

api.get('/conversations/:id/messages', requireAuth, asyncHandler(async (req, res) => {
  const id = paramId(req);
  if (id === null) return res.status(400).json({ error: 'Conversation invalide.' });
  const conv = await getConversationForUser(id, req.user.id);
  if (!conv) return res.status(404).json({ error: 'Conversation introuvable.' });
  const rows = await db.execute({
    sql: `SELECT m.*, u.username AS sender_name FROM messages m
          JOIN users u ON u.id = m.sender_id
          WHERE m.conversation_id = ? ORDER BY m.created_at ASC, m.id ASC`,
    args: [conv.id],
  });
  const otherId = conv.buyer_id === req.user.id ? conv.seller_id : conv.buyer_id;
  res.json({
    conversation: {
      id: conv.id,
      listing_id: conv.listing_id,
      listing_title: conv.listing_title,
      listing_price: (conv.price_cents / 100).toFixed(2),
      listing_status: conv.listing_status,
      buyer_name: conv.buyer_name,
      seller_name: conv.seller_name,
      other_id: otherId,
      other_name: conv.buyer_id === req.user.id ? conv.seller_name : conv.buyer_name,
    },
    messages: rows.rows.map((m) => ({
      id: m.id,
      sender_id: m.sender_id,
      sender_name: m.sender_name,
      body: m.body,
      created_at: m.created_at,
    })),
  });
}));

api.post('/conversations/:id/messages', requireAuth, requireNotBlocked, asyncHandler(async (req, res) => {
  const id = paramId(req);
  if (id === null) return res.status(400).json({ error: 'Conversation invalide.' });
  const conv = await getConversationForUser(id, req.user.id);
  if (!conv) return res.status(404).json({ error: 'Conversation introuvable.' });
  const body = String(req.body?.body || '').trim();
  if (!body || body.length > 2000) {
    return res.status(400).json({ error: 'Le message doit contenir de 1 à 2000 caractères.' });
  }
  const r = await db.execute({
    sql: 'INSERT INTO messages (conversation_id, sender_id, body, created_at) VALUES (?, ?, ?, ?)',
    args: [conv.id, req.user.id, body, nowIso()],
  });
  res.status(201).json({ id: Number(r.lastInsertRowid), sender_id: req.user.id, sender_name: req.user.username, body, created_at: nowIso() });
}));

// ---------------------------------------------------------------------------
// Signalements
// ---------------------------------------------------------------------------
const REPORT_TARGETS = ['listing', 'message', 'user'];

async function reportTargetOwner(targetType, targetId) {
  if (targetType === 'listing') {
    const r = await db.execute({ sql: 'SELECT user_id FROM listings WHERE id = ?', args: [targetId] });
    return r.rows[0] ? Number(r.rows[0].user_id) : null;
  }
  if (targetType === 'message') {
    const r = await db.execute({ sql: 'SELECT sender_id FROM messages WHERE id = ?', args: [targetId] });
    return r.rows[0] ? Number(r.rows[0].sender_id) : null;
  }
  const r = await db.execute({ sql: 'SELECT id FROM users WHERE id = ?', args: [targetId] });
  return r.rows[0] ? Number(r.rows[0].id) : null;
}

api.post('/reports', requireAuth, asyncHandler(async (req, res) => {
  const targetType = String(req.body?.target_type || '');
  const targetId = Number(req.body?.target_id);
  const reason = String(req.body?.reason || '').trim().slice(0, 500);
  if (!REPORT_TARGETS.includes(targetType) || !Number.isInteger(targetId)) {
    return res.status(400).json({ error: 'Signalement invalide.' });
  }
  const ownerId = await reportTargetOwner(targetType, targetId);
  if (ownerId === null) return res.status(404).json({ error: 'Élément introuvable.' });
  if (ownerId === req.user.id) {
    return res.status(400).json({ error: 'Vous ne pouvez pas signaler votre propre annonce, message ou compte.' });
  }
  try {
    const r = await db.execute({
      sql: 'INSERT INTO reports (reporter_id, target_type, target_id, reason, created_at) VALUES (?, ?, ?, ?, ?)',
      args: [req.user.id, targetType, targetId, reason, nowIso()],
    });
    res.status(201).json({ id: Number(r.lastInsertRowid), message: 'Merci, votre signalement a été transmis à l’administrateur.' });
  } catch (e) {
    if (String(e.message || '').includes('UNIQUE')) {
      return res.status(409).json({ error: 'Vous avez déjà signalé cet élément.' });
    }
    throw e;
  }
}));

// ---------------------------------------------------------------------------
// Administration (modération)
// ---------------------------------------------------------------------------
api.get('/admin/reports', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const rows = await db.execute({
    sql: `SELECT r.*, u.username AS reporter_name,
                 CASE r.target_type
                   WHEN 'listing' THEN (SELECT title FROM listings WHERE id = r.target_id)
                   WHEN 'message' THEN (SELECT body FROM messages WHERE id = r.target_id)
                   WHEN 'user' THEN (SELECT username FROM users WHERE id = r.target_id)
                 END AS target_label,
                 CASE r.target_type
                   WHEN 'listing' THEN (SELECT user_id FROM listings WHERE id = r.target_id)
                   WHEN 'message' THEN (SELECT sender_id FROM messages WHERE id = r.target_id)
                   WHEN 'user' THEN r.target_id
                 END AS target_owner_id,
                 CASE r.target_type
                   WHEN 'listing' THEN (SELECT username FROM users WHERE id = (SELECT user_id FROM listings WHERE id = r.target_id))
                   WHEN 'message' THEN (SELECT username FROM users WHERE id = (SELECT sender_id FROM messages WHERE id = r.target_id))
                   WHEN 'user' THEN (SELECT username FROM users WHERE id = r.target_id)
                 END AS target_owner_name,
                 CASE r.target_type
                   WHEN 'listing' THEN (SELECT COUNT(*) FROM reports WHERE target_type = 'listing' AND target_id = r.target_id AND status = 'pending')
                   ELSE 0
                 END AS listing_report_count
          FROM reports r JOIN users u ON u.id = r.reporter_id
          WHERE r.status = 'pending'
          ORDER BY listing_report_count DESC, r.created_at ASC`,
    args: [],
  });
  res.json({
    reports: rows.rows.map((r) => ({
      id: r.id,
      reporter_id: r.reporter_id,
      reporter_name: r.reporter_name,
      target_type: r.target_type,
      target_id: r.target_id,
      target_label: r.target_label || '(élément supprimé)',
      target_owner_id: r.target_owner_id,
      target_owner_name: r.target_owner_name,
      listing_report_count: Number(r.listing_report_count || 0),
      reason: r.reason,
      created_at: r.created_at,
    })),
  });
}));

api.get('/admin/listings', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  // Toutes les annonces, signalées en tête (badge = nombre de signalements en attente).
  const rows = await db.execute({
    sql: `SELECT l.*, u.username AS seller,
                 (SELECT COUNT(*) FROM reports WHERE target_type = 'listing' AND target_id = l.id AND status = 'pending') AS report_count
          FROM listings l JOIN users u ON u.id = l.user_id
          ORDER BY report_count DESC, l.created_at DESC`,
    args: [],
  });
  res.json({ listings: rows.rows.map(listingView) });
}));

api.get('/admin/users', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const rows = await db.execute({
    sql: `SELECT u.*, (SELECT COUNT(*) FROM listings WHERE user_id = u.id) AS listings_count,
                 (SELECT COUNT(*) FROM reports WHERE target_type = 'user' AND target_id = u.id AND status = 'pending') AS report_count
          FROM users u ORDER BY u.created_at ASC`,
    args: [],
  });
  res.json({
    users: rows.rows.map((u) => ({
      ...publicUser(u),
      listings_count: Number(u.listings_count),
      report_count: Number(u.report_count),
    })),
  });
}));

api.post('/admin/reports/:id/dismiss', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const id = paramId(req);
  if (id === null) return res.status(400).json({ error: 'Signalement invalide.' });
  const r = await db.execute({ sql: 'UPDATE reports SET status = ?, resolved_at = ? WHERE id = ? AND status = ?', args: ['dismissed', nowIso(), id, 'pending'] });
  if (r.rowsAffected === 0) return res.status(404).json({ error: 'Signalement introuvable ou déjà traité.' });
  res.json({ ok: true });
}));

api.post('/admin/reports/:id/delete-target', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const id = paramId(req);
  if (id === null) return res.status(400).json({ error: 'Signalement invalide.' });
  const rows = await db.execute({ sql: 'SELECT * FROM reports WHERE id = ?', args: [id] });
  const report = rows.rows[0];
  if (!report || report.status !== 'pending') {
    return res.status(404).json({ error: 'Signalement introuvable ou déjà traité.' });
  }
  if (report.target_type === 'listing') {
    await deleteListingCascade(report.target_id);
  } else if (report.target_type === 'message') {
    await db.execute({ sql: 'DELETE FROM messages WHERE id = ?', args: [report.target_id] });
  } else {
    return res.status(400).json({ error: 'Ce signalement vise un utilisateur : utilisez le blocage.' });
  }
  await db.execute({ sql: "UPDATE reports SET status = 'resolved', resolved_at = ? WHERE id = ?", args: [nowIso(), report.id] });
  res.json({ ok: true });
}));

api.post('/admin/reports/:id/block-user', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const id = paramId(req);
  if (id === null) return res.status(400).json({ error: 'Signalement invalide.' });
  const rows = await db.execute({ sql: 'SELECT * FROM reports WHERE id = ?', args: [id] });
  const report = rows.rows[0];
  if (!report || report.status !== 'pending') {
    return res.status(404).json({ error: 'Signalement introuvable ou déjà traité.' });
  }
  const ownerId = await reportTargetOwner(report.target_type, report.target_id);
  if (ownerId === null) return res.status(404).json({ error: 'Utilisateur visé introuvable.' });
  const target = await db.execute({ sql: 'SELECT * FROM users WHERE id = ?', args: [ownerId] });
  if (target.rows[0]?.is_admin) {
    return res.status(400).json({ error: 'Impossible de bloquer un administrateur.' });
  }
  await db.execute({ sql: 'UPDATE users SET is_blocked = 1 WHERE id = ?', args: [ownerId] });
  await db.execute({ sql: "UPDATE reports SET status = 'resolved', resolved_at = ? WHERE id = ?", args: [nowIso(), report.id] });
  res.json({ ok: true, blocked_user_id: ownerId });
}));

api.post('/admin/users/:id/block', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const id = paramId(req);
  if (id === null) return res.status(400).json({ error: 'Utilisateur invalide.' });
  const target = await db.execute({ sql: 'SELECT * FROM users WHERE id = ?', args: [id] });
  if (!target.rows[0]) return res.status(404).json({ error: 'Utilisateur introuvable.' });
  if (target.rows[0].is_admin) return res.status(400).json({ error: 'Impossible de bloquer un administrateur.' });
  if (id === req.user.id) return res.status(400).json({ error: 'Vous ne pouvez pas vous bloquer vous-même.' });
  await db.execute({ sql: 'UPDATE users SET is_blocked = 1 WHERE id = ?', args: [id] });
  res.json({ ok: true });
}));

api.post('/admin/users/:id/unblock', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const id = paramId(req);
  if (id === null) return res.status(400).json({ error: 'Utilisateur invalide.' });
  await db.execute({ sql: 'UPDATE users SET is_blocked = 0 WHERE id = ?', args: [id] });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Fichiers statiques + gestion des erreurs
// ---------------------------------------------------------------------------
app.use(express.static(path.join(__dirname, 'public')));

app.use((req, res) => {
  res.status(404).json({ error: 'Introuvable.' });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Erreur interne du serveur.' });
});

initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`Hidden Magic écoute sur le port ${PORT}`));
  })
  .catch((err) => {
    console.error('Impossible d’initialiser la base de données :', err);
    process.exit(1);
  });
