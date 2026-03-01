'use strict';

const express     = require('express');
const rateLimit   = require('express-rate-limit');
const Database    = require('better-sqlite3');
const jwt         = require('jsonwebtoken');
const bcrypt      = require('bcryptjs');
const path        = require('path');
const crypto      = require('crypto');
const fs          = require('fs');

// ── Configuration ──────────────────────────────────────────────────────────────
const PORT       = parseInt(process.env.PORT || '3000', 10);
const DB_PATH    = process.env.DB_PATH    || path.join(__dirname, 'data.db');
const SECRET_FILE = path.join(__dirname, '.jwt_secret');

function loadOrCreateSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (fs.existsSync(SECRET_FILE)) return fs.readFileSync(SECRET_FILE, 'utf8').trim();
  const secret = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(SECRET_FILE, secret, { mode: 0o600 });
  return secret;
}
const JWT_SECRET = loadOrCreateSecret();
const BCRYPT_ROUNDS = 10;

// ── Database setup ─────────────────────────────────────────────────────────────
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT    UNIQUE NOT NULL COLLATE NOCASE,
    password_hash TEXT    NOT NULL
  );

  CREATE TABLE IF NOT EXISTS profiles (
    user_id  INTEGER PRIMARY KEY,
    data     TEXT    NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS workouts (
    id       TEXT    PRIMARY KEY,
    user_id  INTEGER NOT NULL,
    date     TEXT    NOT NULL,
    data     TEXT    NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS weights (
    user_id  INTEGER NOT NULL,
    date     TEXT    NOT NULL,
    data     TEXT    NOT NULL,
    PRIMARY KEY (user_id, date),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS calories (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id  INTEGER NOT NULL,
    date     TEXT    NOT NULL,
    data     TEXT    NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

// ── Prepared statements ─────────────────────────────────────────────────────────
const stmts = {
  findUser:       db.prepare('SELECT * FROM users WHERE username = ?'),
  insertUser:     db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)'),
  getProfile:     db.prepare('SELECT data FROM profiles WHERE user_id = ?'),
  upsertProfile:  db.prepare('INSERT INTO profiles (user_id, data) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET data = excluded.data'),
  getWorkouts:    db.prepare('SELECT id, data FROM workouts WHERE user_id = ? ORDER BY date DESC'),
  insertWorkout:  db.prepare('INSERT INTO workouts (id, user_id, date, data) VALUES (?, ?, ?, ?)'),
  deleteWorkout:  db.prepare('DELETE FROM workouts WHERE id = ? AND user_id = ?'),
  getWeights:     db.prepare('SELECT data FROM weights WHERE user_id = ? ORDER BY date'),
  upsertWeight:   db.prepare('INSERT INTO weights (user_id, date, data) VALUES (?, ?, ?) ON CONFLICT(user_id, date) DO UPDATE SET data = excluded.data'),
  deleteWeight:   db.prepare('DELETE FROM weights WHERE user_id = ? AND date = ?'),
  getCalories:    db.prepare('SELECT id, data FROM calories WHERE user_id = ? ORDER BY date, id'),
  insertCalorie:  db.prepare('INSERT INTO calories (user_id, date, data) VALUES (?, ?, ?)'),
  deleteCalorie:  db.prepare('DELETE FROM calories WHERE id = ? AND user_id = ?'),
  deleteUserData: db.prepare('DELETE FROM profiles WHERE user_id = ?'),
};

// ── Express app ─────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

// ── Rate limiters ───────────────────────────────────────────────────────────────
// Strict limiter for authentication endpoints (prevents brute-force)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' },
});

// General limiter for all other API endpoints
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' },
});

app.use('/api/auth/', authLimiter);
app.use('/api/', apiLimiter);

// Serve static frontend files from the dedicated public directory
app.use(express.static(path.join(__dirname, 'public'), { dotfiles: 'deny' }));

// ── Auth middleware ─────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authentication required.' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token.' });
  }
}

// ── Auth routes ─────────────────────────────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required.' });
  if (!/^[a-zA-Z0-9_]{2,30}$/.test(username)) {
    return res.status(400).json({ error: 'Username must be 2–30 characters (letters, numbers, underscores).' });
  }
  if (typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }
  if (stmts.findUser.get(username)) {
    return res.status(409).json({ error: 'Username already taken.' });
  }
  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const info = stmts.insertUser.run(username, hash);
  const token = jwt.sign({ userId: info.lastInsertRowid, username }, JWT_SECRET, { expiresIn: '7d' });
  res.status(201).json({ token });
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required.' });
  const user = stmts.findUser.get(username);
  if (!user) return res.status(401).json({ error: 'User not found.' });
  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) return res.status(401).json({ error: 'Incorrect password.' });
  const token = jwt.sign({ userId: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token });
});

// ── Profile routes ──────────────────────────────────────────────────────────────
app.get('/api/profile', requireAuth, (req, res) => {
  const row = stmts.getProfile.get(req.user.userId);
  res.json(row ? JSON.parse(row.data) : null);
});

app.put('/api/profile', requireAuth, (req, res) => {
  stmts.upsertProfile.run(req.user.userId, JSON.stringify(req.body));
  res.json({ ok: true });
});

// ── User data reset ─────────────────────────────────────────────────────────────
app.delete('/api/user/data', requireAuth, (req, res) => {
  const uid = req.user.userId;
  db.transaction(() => {
    db.prepare('DELETE FROM profiles  WHERE user_id = ?').run(uid);
    db.prepare('DELETE FROM workouts  WHERE user_id = ?').run(uid);
    db.prepare('DELETE FROM weights   WHERE user_id = ?').run(uid);
    db.prepare('DELETE FROM calories  WHERE user_id = ?').run(uid);
  })();
  res.json({ ok: true });
});

// ── Workout routes ──────────────────────────────────────────────────────────────
app.get('/api/workouts', requireAuth, (req, res) => {
  const rows = stmts.getWorkouts.all(req.user.userId);
  res.json(rows.map(r => JSON.parse(r.data)));
});

app.post('/api/workouts', requireAuth, (req, res) => {
  const session = req.body;
  if (!session || !session.date || !Array.isArray(session.exercises)) {
    return res.status(400).json({ error: 'Invalid workout data.' });
  }
  const id = session.id || crypto.randomUUID();
  session.id = id;
  stmts.insertWorkout.run(id, req.user.userId, session.date, JSON.stringify(session));
  res.status(201).json({ ok: true, id });
});

app.delete('/api/workouts/:id', requireAuth, (req, res) => {
  const info = stmts.deleteWorkout.run(req.params.id, req.user.userId);
  if (info.changes === 0) return res.status(404).json({ error: 'Workout not found.' });
  res.json({ ok: true });
});

// ── Weight routes ───────────────────────────────────────────────────────────────
app.get('/api/weights', requireAuth, (req, res) => {
  const rows = stmts.getWeights.all(req.user.userId);
  res.json(rows.map(r => JSON.parse(r.data)));
});

app.post('/api/weights', requireAuth, (req, res) => {
  const entry = req.body;
  if (!entry || !entry.date || !entry.weight) {
    return res.status(400).json({ error: 'Date and weight are required.' });
  }
  stmts.upsertWeight.run(req.user.userId, entry.date, JSON.stringify(entry));
  res.status(201).json({ ok: true });
});

app.delete('/api/weights/:date', requireAuth, (req, res) => {
  const info = stmts.deleteWeight.run(req.user.userId, req.params.date);
  if (info.changes === 0) return res.status(404).json({ error: 'Weight entry not found.' });
  res.json({ ok: true });
});

// ── Calorie routes ──────────────────────────────────────────────────────────────
app.get('/api/calories', requireAuth, (req, res) => {
  const rows = stmts.getCalories.all(req.user.userId);
  res.json(rows.map(r => ({ ...JSON.parse(r.data), id: r.id })));
});

app.post('/api/calories', requireAuth, (req, res) => {
  const entry = req.body;
  if (!entry || !entry.date || !entry.food || entry.calories === undefined) {
    return res.status(400).json({ error: 'Date, food and calories are required.' });
  }
  const info = stmts.insertCalorie.run(req.user.userId, entry.date, JSON.stringify(entry));
  res.status(201).json({ ok: true, id: info.lastInsertRowid });
});

app.delete('/api/calories/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id.' });
  const info = stmts.deleteCalorie.run(id, req.user.userId);
  if (info.changes === 0) return res.status(404).json({ error: 'Calorie entry not found.' });
  res.json({ ok: true });
});

// ── Food search proxy ────────────────────────────────────────────────────────────
app.get('/api/food/search', requireAuth, async (req, res) => {
  const query = (req.query.q || '').trim();
  if (!query) return res.status(400).json({ error: 'Query parameter q is required.' });

  try {
    const url = `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(query)}&json=true&page_size=10&fields=product_name,nutriments`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'DaveGetsFit/1.0 (fitness tracking app)' },
      signal: AbortSignal.timeout(8000),
    });

    if (!response.ok) throw new Error('Upstream API error');
    const json = await response.json();

    const results = (json.products || [])
      .filter(p => p.product_name)
      .map(p => ({
        name:     p.product_name,
        calories: p.nutriments?.['energy-kcal_100g'] ?? null,
        protein:  p.nutriments?.proteins_100g ?? null,
        carbs:    p.nutriments?.carbohydrates_100g ?? null,
        fat:      p.nutriments?.fat_100g ?? null,
      }));

    res.json(results);
  } catch (err) {
    console.error('Food search error:', err.message || err);
    res.status(502).json({ error: 'Food search unavailable. Please enter details manually.' });
  }
});

// ── Barcode lookup ────────────────────────────────────────────────────────────
app.get('/api/food/barcode/:barcode', requireAuth, async (req, res) => {
  const barcode = req.params.barcode.trim();
  if (!/^\d{6,14}$/.test(barcode)) {
    return res.status(400).json({ error: 'Invalid barcode format.' });
  }

  try {
    const url = `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(barcode)}.json?fields=product_name,nutriments`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'DaveGetsFit/1.0 (fitness tracking app)' },
      signal: AbortSignal.timeout(8000),
    });

    if (!response.ok) throw new Error('Upstream API error');
    const json = await response.json();

    if (json.status !== 1 || !json.product) {
      return res.status(404).json({ error: 'Product not found for this barcode.' });
    }

    const p = json.product;
    res.json({
      name:     p.product_name || 'Unknown product',
      calories: p.nutriments?.['energy-kcal_100g'] ?? null,
      protein:  p.nutriments?.proteins_100g ?? null,
      carbs:    p.nutriments?.carbohydrates_100g ?? null,
      fat:      p.nutriments?.fat_100g ?? null,
    });
  } catch (err) {
    console.error('Barcode lookup error:', err.message || err);
    res.status(502).json({ error: 'Barcode lookup unavailable. Please enter details manually.' });
  }
});

// ── Start server ─────────────────────────────────────────────────────────────────
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Dave Gets Fit server running on http://localhost:${PORT}`);
  });
}

module.exports = app;
