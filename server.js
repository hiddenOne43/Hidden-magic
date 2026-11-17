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

// Valeur de marché (prix Scryfall) : taux de change approximatif USD -> CAD.
const USD_TO_CAD = 1.40; // À ajuster si le taux s'éloigne durablement de 1,40.
const PRICE_TTL_MS = 24 * 60 * 60 * 1000; // Un prix est frais pendant 24 h.
const PRICE_FETCH_DELAY_MS = 200; // ~5 appels/s, sous la limite demandée par Scryfall (~10/s).
// Base de l'API Scryfall. La variable SCRYFALL_API_BASE ne sert qu'aux tests
// locaux (pointer vers un faux serveur) ; en production, l'API réelle.
const SCRYFALL_API_BASE = (process.env.SCRYFALL_API_BASE || 'https://api.scryfall.com').replace(/\/$/, '');
const SCRYFALL_USER_AGENT = 'Hidden-Magic/1.0';

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
      listing_id INTEGER REFERENCES listings(id) ON DELETE CASCADE,
      trade_item_id INTEGER REFERENCES trade_items(id) ON DELETE SET NULL,
      context_label TEXT NOT NULL DEFAULT '',
      context_kind TEXT NOT NULL DEFAULT 'listing',
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
    CREATE TABLE IF NOT EXISTS trade_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      name TEXT NOT NULL,
      set_code TEXT NOT NULL DEFAULT '',
      set_name TEXT NOT NULL DEFAULT '',
      collector_number TEXT NOT NULL DEFAULT '',
      foil INTEGER NOT NULL DEFAULT 0,
      condition TEXT NOT NULL DEFAULT '',
      language TEXT NOT NULL DEFAULT '',
      quantity INTEGER NOT NULL DEFAULT 1,
      scryfall_id TEXT NOT NULL DEFAULT '',
      binder_name TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT 'trade',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_trade_user ON trade_items(user_id);
    CREATE INDEX IF NOT EXISTS idx_trade_kind ON trade_items(kind);
    CREATE INDEX IF NOT EXISTS idx_trade_name ON trade_items(name);
    CREATE TABLE IF NOT EXISTS card_prices (
      scryfall_id TEXT PRIMARY KEY,
      usd REAL,
      usd_foil REAL,
      eur REAL,
      fetched_at INTEGER NOT NULL
    );
  `);

  // Migration : une conversation peut porter sur un article d'échange
  // (listing_id devient facultatif ; ajout de trade_item_id, context_label
  // et context_kind). Sans effet sur les conversations d'annonces et les
  // messages existants. Idempotente.
  // Attention : libsql applique les clés étrangères par défaut ; il faut
  // couper leur vérification pendant la reconstruction de la table, sinon
  // la suppression de l'ancienne table efface les messages en cascade
  // (ON DELETE CASCADE). Tout passe par un seul executeMultiple pour rester
  // sur la même connexion (PRAGMA foreign_keys est propre à la connexion).
  const convCols = await db.execute('PRAGMA table_info(conversations)');
  const convColNames = convCols.rows.map((r) => r.name);
  if (!convColNames.includes('trade_item_id')) {
    await db.executeMultiple(`
      PRAGMA foreign_keys = OFF;
      DROP TABLE IF EXISTS conversations_new;
      CREATE TABLE conversations_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        listing_id INTEGER REFERENCES listings(id) ON DELETE CASCADE,
        trade_item_id INTEGER REFERENCES trade_items(id) ON DELETE SET NULL,
        context_label TEXT NOT NULL DEFAULT '',
        context_kind TEXT NOT NULL DEFAULT 'listing',
        buyer_id INTEGER NOT NULL REFERENCES users(id),
        seller_id INTEGER NOT NULL REFERENCES users(id),
        created_at TEXT NOT NULL,
        UNIQUE (listing_id, buyer_id)
      );
      INSERT INTO conversations_new (id, listing_id, trade_item_id, context_label, context_kind, buyer_id, seller_id, created_at)
        SELECT id, listing_id, NULL, '', 'listing', buyer_id, seller_id, created_at FROM conversations;
      DROP TABLE conversations;
      ALTER TABLE conversations_new RENAME TO conversations;
      PRAGMA foreign_keys = ON;
    `);
    const fkCheck = await db.execute('PRAGMA foreign_key_check');
    if (fkCheck.rows.length > 0) {
      console.error('Migration des conversations : violations de clés étrangères :', fkCheck.rows);
    }
  }
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
                 COALESCE(t.name, c.context_label) AS trade_name,
                 t.kind AS trade_kind,
                 b.username AS buyer_name, s.username AS seller_name
          FROM conversations c
          LEFT JOIN listings l ON l.id = c.listing_id
          LEFT JOIN trade_items t ON t.id = c.trade_item_id
          JOIN users b ON b.id = c.buyer_id
          JOIN users s ON s.id = c.seller_id
          WHERE c.id = ? AND (c.buyer_id = ? OR c.seller_id = ?)`,
    args: [convId, userId, userId],
  });
  return rows.rows[0] || null;
}

// Forme d'une conversation pour le client : annonce OU échange.
// Le type est figé à la création (context_kind) : il survit à la
// suppression de l'article d'échange (trade_item_id mis à NULL).
function conversationView(c, meId) {
  const isTrade = c.context_kind === 'trade';
  return {
    id: c.id,
    kind: isTrade ? 'trade' : 'listing',
    listing_id: c.listing_id || null,
    listing_title: c.listing_title || null,
    listing_price: c.price_cents != null ? (c.price_cents / 100).toFixed(2) : null,
    listing_status: c.listing_status || null,
    listing_photo: c.listing_photo || null,
    trade_item_id: c.trade_item_id || null,
    trade_name: c.trade_name || null,
    trade_kind: c.trade_kind || null,
    buyer_id: c.buyer_id,
    buyer_name: c.buyer_name,
    seller_id: c.seller_id,
    seller_name: c.seller_name,
    other_name: c.buyer_id === meId ? c.seller_name : c.buyer_name,
    other_id: c.buyer_id === meId ? c.seller_id : c.buyer_id,
    last_body: c.last_body || null,
    last_at: c.last_at || c.created_at,
    created_at: c.created_at,
  };
}

api.get('/conversations', requireAuth, asyncHandler(async (req, res) => {
  const rows = await db.execute({
    sql: `SELECT c.*, l.title AS listing_title, l.price_cents, l.status AS listing_status,
                 l.photo AS listing_photo,
                 COALESCE(t.name, c.context_label) AS trade_name,
                 t.kind AS trade_kind,
                 b.username AS buyer_name, s.username AS seller_name,
                 (SELECT body FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_body,
                 (SELECT created_at FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_at
          FROM conversations c
          LEFT JOIN listings l ON l.id = c.listing_id
          LEFT JOIN trade_items t ON t.id = c.trade_item_id
          JOIN users b ON b.id = c.buyer_id
          JOIN users s ON s.id = c.seller_id
          WHERE c.buyer_id = ? OR c.seller_id = ?
          ORDER BY COALESCE(last_at, c.created_at) DESC`,
    args: [req.user.id, req.user.id],
  });
  res.json({ conversations: rows.rows.map((c) => conversationView(c, req.user.id)) });
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
    sql: 'INSERT INTO conversations (listing_id, trade_item_id, context_label, context_kind, buyer_id, seller_id, created_at) VALUES (?, NULL, \'\', \'listing\', ?, ?, ?)',
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
      kind: conv.context_kind === 'trade' ? 'trade' : 'listing',
      listing_id: conv.listing_id || null,
      listing_title: conv.listing_title || null,
      listing_price: conv.price_cents != null ? (conv.price_cents / 100).toFixed(2) : null,
      listing_status: conv.listing_status || null,
      trade_item_id: conv.trade_item_id || null,
      trade_name: conv.trade_name || null,
      trade_kind: conv.trade_kind || null,
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
// Échange (collection à échanger + cartes recherchées, import ManaBox)
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Valeurs de marché (prix Scryfall, cache local de 24 h)
// ---------------------------------------------------------------------------
// Les prix viennent de l'API Scryfall (gratuite, sans clé ; prix TCGplayer /
// Cardmarket). Pour respecter ses limites (~10 appels/s, 50-100 ms entre
// requêtes), les prix sont récupérés en arrière-plan, une carte à la fois
// (~200 ms entre appels), et mis en cache 24 h dans card_prices.
// Les réponses API ne sont jamais bloquées sur Scryfall : elles renvoient
// les prix déjà en cache (null sinon). La file est dérivée des données :
// chaque lecture de la liste d'échange ré-enfile les cartes sans prix frais,
// donc le système se répare seul après un redémarrage (le service gratuit
// Render s'endort après 15 min d'inactivité). Les minuteurs sont en unref()
// pour ne pas retenir le processus (tests).
async function fetchJson(url) {
  if (typeof globalThis.fetch === 'function') {
    const res = await globalThis.fetch(url, {
      headers: { 'User-Agent': SCRYFALL_USER_AGENT, Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`Scryfall ${res.status}`);
    return res.json();
  }
  // Repli Node < 18 (sans fetch global) : module https.
  const https = require('node:https');
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': SCRYFALL_USER_AGENT, Accept: 'application/json' } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`Scryfall ${res.statusCode}`));
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// Prix d'une carte Scryfall (les prix sont des chaînes ou null côté Scryfall).
async function fetchCardPrice(scryfallId) {
  const card = await fetchJson(`${SCRYFALL_API_BASE}/cards/${encodeURIComponent(scryfallId)}`);
  const p = card?.prices || {};
  const num = (v) => {
    const n = typeof v === 'string' ? parseFloat(v) : v;
    return typeof n === 'number' && Number.isFinite(n) ? n : null;
  };
  return { usd: num(p.usd), usd_foil: num(p.usd_foil), eur: num(p.eur) };
}

async function loadCachedPrices(ids) {
  const map = new Map();
  const list = [...new Set(ids.filter(Boolean))];
  if (!list.length) return map;
  const placeholders = list.map(() => '?').join(',');
  const rows = await db.execute({
    sql: `SELECT * FROM card_prices WHERE scryfall_id IN (${placeholders})`,
    args: list,
  });
  for (const r of rows.rows) map.set(r.scryfall_id, r);
  return map;
}

function isPriceFresh(row) {
  return !!row && typeof row.fetched_at === 'number' && (Date.now() - row.fetched_at) < PRICE_TTL_MS;
}

const priceQueue = new Set();
const priceInFlight = new Set(); // récupérations en cours (évite les doublons)
let priceWorkerActive = false;

function enqueuePrices(ids, cache) {
  let added = false;
  for (const id of new Set(ids.filter(Boolean))) {
    if (!isPriceFresh(cache.get(id)) && !priceQueue.has(id) && !priceInFlight.has(id)) {
      priceQueue.add(id);
      added = true;
    }
  }
  if (added) kickPriceWorker();
}

// Récupère un prix et l'enregistre. En cas d'échec, on enregistre quand même
// fetched_at = maintenant avec des valeurs nulles : la carte ne sera pas
// réessayée à chaque chargement, seulement après 24 h.
async function processPrice(id) {
  let prices = { usd: null, usd_foil: null, eur: null };
  try {
    prices = await fetchCardPrice(id);
  } catch (e) {
    console.error(`Prix Scryfall introuvable pour ${id} :`, e.message);
  }
  try {
    await db.execute({
      sql: `INSERT OR REPLACE INTO card_prices (scryfall_id, usd, usd_foil, eur, fetched_at)
            VALUES (?, ?, ?, ?, ?)`,
      args: [id, prices.usd, prices.usd_foil, prices.eur, Date.now()],
    });
  } catch (e) {
    console.error(`Impossible d'enregistrer le prix de ${id} :`, e.message);
  }
}

function kickPriceWorker() {
  if (priceWorkerActive) return;
  priceWorkerActive = true;
  const step = () => {
    const next = priceQueue.values().next();
    if (next.done) { priceWorkerActive = false; return; }
    const id = next.value;
    priceQueue.delete(id);
    priceInFlight.add(id);
    processPrice(id).finally(() => {
      priceInFlight.delete(id);
      const t = setTimeout(step, PRICE_FETCH_DELAY_MS);
      if (typeof t.unref === 'function') t.unref();
    });
  };
  const t = setTimeout(step, 0);
  if (typeof t.unref === 'function') t.unref();
}

// Enfile les prix manquants ou périmés (sans bloquer l'appelant).
function ensurePrices(ids) {
  loadCachedPrices(ids)
    .then((cache) => enqueuePrices(ids, cache))
    .catch((e) => console.error('ensurePrices :', e.message));
}

// Valeur de marché d'une carte : prix foil si foil (repli sur le prix
// normal), sinon prix normal. Conversion CAD approximative.
function marketValue(foil, priceRow) {
  if (!priceRow) return { market_usd: null, market_cad_approx: null };
  const usd = foil ? (priceRow.usd_foil ?? priceRow.usd) : priceRow.usd;
  if (typeof usd !== 'number' || !Number.isFinite(usd)) return { market_usd: null, market_cad_approx: null };
  return { market_usd: usd, market_cad_approx: Math.round(usd * USD_TO_CAD * 100) / 100 };
}

function tradeItemView(r, priceRow) {
  return {
    id: r.id,
    user_id: r.user_id,
    seller: r.seller,
    name: r.name,
    set_code: r.set_code,
    set_name: r.set_name,
    collector_number: r.collector_number,
    foil: !!r.foil,
    condition: r.condition,
    language: r.language,
    quantity: Number(r.quantity),
    scryfall_id: r.scryfall_id,
    binder_name: r.binder_name,
    kind: r.kind,
    created_at: r.created_at,
    ...marketValue(!!r.foil, priceRow),
  };
}

// Vues d'articles d'échange avec leurs valeurs de marché (cache uniquement).
// Ré-enfile les cartes sans prix frais pour que la file se répare seule.
async function tradeViews(rows) {
  const ids = rows.map((r) => r.scryfall_id);
  const cache = await loadCachedPrices(ids);
  enqueuePrices(ids, cache);
  return rows.map((r) => tradeItemView(r, cache.get(r.scryfall_id)));
}

const TRADE_SELECT = `
  SELECT t.*, u.username AS seller
  FROM trade_items t JOIN users u ON u.id = t.user_id`;

// Analyseur CSV écrit à la main (champs entre guillemets, virgules et
// guillemets doublés "" gérés ; fins de ligne LF, CRLF ou CR).
function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // BOM éventuel
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field); field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

const MAX_IMPORT_ROWS = 5000;

api.get('/trade', asyncHandler(async (req, res) => {
  const q = String(req.query.q || '').trim();
  const kind = String(req.query.kind || '').trim();
  const where = [];
  const args = [];
  if (q) {
    where.push('(t.name LIKE ? OR t.set_name LIKE ? OR u.username LIKE ?)');
    const like = `%${q}%`;
    args.push(like, like, like);
  }
  if (kind === 'trade' || kind === 'want') {
    where.push('t.kind = ?');
    args.push(kind);
  }
  const rows = await db.execute({
    sql: `${TRADE_SELECT}${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY t.created_at DESC LIMIT 100`,
    args,
  });
  res.json({ items: await tradeViews(rows.rows) });
}));

api.get('/trade/binders', asyncHandler(async (req, res) => {
  const rows = await db.execute({
    sql: `SELECT u.id AS user_id, u.username,
                 SUM(CASE WHEN t.kind = 'trade' THEN 1 ELSE 0 END) AS trade_count,
                 SUM(CASE WHEN t.kind = 'want' THEN 1 ELSE 0 END) AS want_count,
                 COUNT(*) AS total
          FROM trade_items t JOIN users u ON u.id = t.user_id
          GROUP BY u.id, u.username ORDER BY total DESC`,
    args: [],
  });
  res.json({
    binders: rows.rows.map((b) => ({
      user_id: b.user_id,
      username: b.username,
      trade_count: Number(b.trade_count),
      want_count: Number(b.want_count),
      total: Number(b.total),
    })),
  });
}));

api.get('/trade/user/:userId', asyncHandler(async (req, res) => {
  const userId = Number(req.params.userId);
  if (!Number.isInteger(userId)) return res.status(400).json({ error: 'Utilisateur invalide.' });
  const user = await db.execute({ sql: 'SELECT id, username FROM users WHERE id = ?', args: [userId] });
  if (!user.rows[0]) return res.status(404).json({ error: 'Utilisateur introuvable.' });
  const rows = await db.execute({
    sql: `${TRADE_SELECT} WHERE t.user_id = ? ORDER BY t.kind ASC, t.created_at DESC LIMIT 500`,
    args: [userId],
  });
  res.json({ user: { id: user.rows[0].id, username: user.rows[0].username }, items: await tradeViews(rows.rows) });
}));

api.post('/trade/import', requireAuth, requireNotBlocked, asyncHandler(async (req, res) => {
  const csv = typeof req.body?.csv === 'string' ? req.body.csv : '';
  if (!csv.trim()) return res.status(400).json({ error: 'Fichier CSV vide.' });
  if (csv.length > 2_000_000) return res.status(400).json({ error: 'Fichier CSV trop volumineux.' });
  const rows = parseCsv(csv);
  if (!rows.length) return res.status(400).json({ error: 'Fichier CSV vide.' });
  const headers = rows[0].map((h) => String(h || '').trim().toLowerCase());
  const col = (name) => headers.indexOf(name.toLowerCase());
  const idx = {
    binderName: col('Binder Name'),
    binderType: col('Binder Type'),
    name: col('Name'),
    setCode: col('Set code'),
    setName: col('Set name'),
    collectorNumber: col('Collector number'),
    foil: col('Foil'),
    quantity: col('Quantity'),
    scryfallId: col('Scryfall ID'),
    condition: col('Condition'),
    language: col('Language'),
  };
  if (idx.name < 0) {
    return res.status(400).json({ error: 'Colonne « Name » introuvable dans le CSV. Vérifiez qu’il s’agit bien d’un export ManaBox.' });
  }
  const cell = (r, i) => (i >= 0 && i < r.length ? String(r[i] ?? '').trim() : '');
  let imported = 0;
  let trade = 0;
  let want = 0;
  let skipped = 0;
  const items = [];
  for (let n = 1; n < rows.length; n++) {
    const r = rows[n];
    if (n > MAX_IMPORT_ROWS) { skipped++; continue; }
    if (r.every((c) => String(c ?? '').trim() === '')) continue; // ligne vide
    const name = cell(r, idx.name);
    if (!name) { skipped++; continue; }
    const binderType = cell(r, idx.binderType).toLowerCase();
    let kind;
    if (binderType.includes('list')) kind = 'want';
    else if (binderType.includes('binder')) kind = 'trade';
    else { skipped++; continue; }
    const foilRaw = cell(r, idx.foil).toLowerCase();
    const foil = ['yes', 'true', '1', 'oui'].includes(foilRaw) ? 1 : 0;
    let quantity = parseInt(cell(r, idx.quantity) || '1', 10);
    if (!Number.isFinite(quantity) || quantity < 1) quantity = 1;
    if (quantity > 999) quantity = 999;
    items.push({
      name: name.slice(0, 120),
      set_code: cell(r, idx.setCode).slice(0, 20),
      set_name: cell(r, idx.setName).slice(0, 120),
      collector_number: cell(r, idx.collectorNumber).slice(0, 20),
      foil,
      condition: cell(r, idx.condition).slice(0, 40),
      language: cell(r, idx.language).slice(0, 30),
      quantity,
      scryfall_id: cell(r, idx.scryfallId).slice(0, 50),
      binder_name: cell(r, idx.binderName).slice(0, 80),
      kind,
    });
    if (kind === 'trade') trade++;
    else want++;
    imported++;
  }
  // L'import remplace la collection d'échange actuelle (réimport = mise à jour).
  await db.execute({ sql: 'DELETE FROM trade_items WHERE user_id = ?', args: [req.user.id] });
  for (const it of items) {
    await db.execute({
      sql: `INSERT INTO trade_items (user_id, name, set_code, set_name, collector_number, foil, condition, language, quantity, scryfall_id, binder_name, kind, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [req.user.id, it.name, it.set_code, it.set_name, it.collector_number, it.foil, it.condition, it.language, it.quantity, it.scryfall_id, it.binder_name, it.kind, nowIso()],
    });
  }
  // Valeurs de marché : résolution en arrière-plan, sans bloquer la réponse.
  ensurePrices(items.map((it) => it.scryfall_id));
  res.json({ imported, trade, want, skipped });
}));

api.post('/trade', requireAuth, requireNotBlocked, asyncHandler(async (req, res) => {
  const name = String(req.body?.name || '').trim();
  const kind = req.body?.kind === 'want' ? 'want' : 'trade';
  const setCode = String(req.body?.set_code || '').trim().slice(0, 20);
  const setName = String(req.body?.set_name || '').trim().slice(0, 120);
  const collectorNumber = String(req.body?.collector_number || '').trim().slice(0, 20);
  const foil = req.body?.foil ? 1 : 0;
  const condition = String(req.body?.condition || '').trim().slice(0, 40);
  const language = String(req.body?.language || '').trim().slice(0, 30);
  const binderName = String(req.body?.binder_name || '').trim().slice(0, 80);
  let quantity = parseInt(String(req.body?.quantity ?? '1'), 10);
  if (!Number.isFinite(quantity) || quantity < 1) quantity = 1;
  if (quantity > 999) quantity = 999;
  if (name.length < 2 || name.length > 120) return res.status(400).json({ error: 'Le nom de la carte est requis (2 à 120 caractères).' });
  const r = await db.execute({
    sql: `INSERT INTO trade_items (user_id, name, set_code, set_name, collector_number, foil, condition, language, quantity, scryfall_id, binder_name, kind, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?)`,
    args: [req.user.id, name, setCode, setName, collectorNumber, foil, condition, language, quantity, binderName, kind, nowIso()],
  });
  const rows = await db.execute({ sql: `${TRADE_SELECT} WHERE t.id = ?`, args: [Number(r.lastInsertRowid)] });
  res.status(201).json({ item: tradeItemView(rows.rows[0]) });
}));

api.delete('/trade/:id', requireAuth, asyncHandler(async (req, res) => {
  const id = paramId(req);
  if (id === null) return res.status(400).json({ error: 'Article invalide.' });
  const rows = await db.execute({ sql: 'SELECT * FROM trade_items WHERE id = ?', args: [id] });
  const item = rows.rows[0];
  if (!item) return res.status(404).json({ error: 'Article introuvable.' });
  if (item.user_id !== req.user.id && !req.user.is_admin) {
    return res.status(403).json({ error: 'Vous ne pouvez supprimer que vos propres articles d’échange.' });
  }
  // Les conversations liées gardent leur contexte (nom de la carte) sans l'article.
  await db.execute({ sql: 'UPDATE conversations SET trade_item_id = NULL WHERE trade_item_id = ?', args: [id] });
  await db.execute({ sql: 'DELETE FROM trade_items WHERE id = ?', args: [id] });
  res.json({ ok: true });
}));

api.post('/trade/:id/contact', requireAuth, requireNotBlocked, asyncHandler(async (req, res) => {
  const id = paramId(req);
  if (id === null) return res.status(400).json({ error: 'Article invalide.' });
  const rows = await db.execute({
    sql: `${TRADE_SELECT} WHERE t.id = ?`,
    args: [id],
  });
  const item = rows.rows[0];
  if (!item) return res.status(404).json({ error: 'Article introuvable.' });
  if (item.user_id === req.user.id) {
    return res.status(400).json({ error: 'Vous ne pouvez pas vous écrire à vous-même.' });
  }
  const seller = await db.execute({ sql: 'SELECT * FROM users WHERE id = ?', args: [item.user_id] });
  if (seller.rows[0]?.is_blocked) {
    return res.status(403).json({ error: 'Cet utilisateur est bloqué et ne peut pas être contacté.' });
  }
  const existing = await db.execute({
    sql: 'SELECT id FROM conversations WHERE trade_item_id = ? AND buyer_id = ?',
    args: [id, req.user.id],
  });
  if (existing.rows[0]) return res.json({ conversation_id: existing.rows[0].id, existing: true });
  const label = item.set_name ? `${item.name} (${item.set_name})` : item.name;
  const r = await db.execute({
    sql: 'INSERT INTO conversations (listing_id, trade_item_id, context_label, context_kind, buyer_id, seller_id, created_at) VALUES (NULL, ?, ?, \'trade\', ?, ?, ?)',
    args: [id, label, req.user.id, item.user_id, nowIso()],
  });
  res.status(201).json({ conversation_id: Number(r.lastInsertRowid), existing: false });
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
