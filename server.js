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
const PORT     = parseInt(process.env.PORT || '3000', 10);
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DB_PATH  = process.env.DB_PATH  || path.join(DATA_DIR, 'data.db');
const SECRET_FILE = path.join(DATA_DIR, '.jwt_secret');

function loadOrCreateSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (fs.existsSync(SECRET_FILE)) return fs.readFileSync(SECRET_FILE, 'utf8').trim();
  const secret = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(SECRET_FILE, secret, { mode: 0o600 });
  return secret;
}
const JWT_SECRET = loadOrCreateSecret();
const BCRYPT_ROUNDS = 10;
const VALID_ROLES   = ['admin', 'user', 'trainer'];

// ── Database setup ─────────────────────────────────────────────────────────────
console.log(`[GetUs.Fit] Database: ${DB_PATH}`);
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT    UNIQUE NOT NULL COLLATE NOCASE,
    password_hash TEXT    NOT NULL,
    role          TEXT    NOT NULL DEFAULT 'user'
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

  CREATE TABLE IF NOT EXISTS trainer_assignments (
    trainer_id INTEGER NOT NULL,
    user_id    INTEGER NOT NULL,
    PRIMARY KEY (trainer_id, user_id),
    FOREIGN KEY (trainer_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id)    REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS plans (
    id         TEXT    PRIMARY KEY,
    trainer_id INTEGER NOT NULL,
    name       TEXT    NOT NULL,
    data       TEXT    NOT NULL,
    FOREIGN KEY (trainer_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS plan_assignments (
    plan_id  TEXT    NOT NULL,
    user_id  INTEGER NOT NULL,
    PRIMARY KEY (plan_id, user_id),
    FOREIGN KEY (plan_id) REFERENCES plans(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS scheduled_workouts (
    id       TEXT    PRIMARY KEY,
    user_id  INTEGER NOT NULL,
    date     TEXT    NOT NULL,
    plan_id  TEXT,
    title    TEXT    NOT NULL,
    notes    TEXT    NOT NULL DEFAULT '',
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (plan_id) REFERENCES plans(id) ON DELETE SET NULL
  );
`);

// Migration: add role column to databases created before this feature
try { db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'"); } catch {}

// Migration: add google_id column for social sign-in
try { db.exec('ALTER TABLE users ADD COLUMN google_id TEXT'); } catch {}
try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id) WHERE google_id IS NOT NULL'); } catch {}

// ── Prepared statements ─────────────────────────────────────────────────────────
const stmts = {
  findUser:            db.prepare('SELECT * FROM users WHERE username = ?'),
  findUserByGoogleId:  db.prepare('SELECT * FROM users WHERE google_id = ?'),
  insertUser:          db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)'),
  insertUserWithRole:  db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)'),
  insertGoogleUser:    db.prepare("INSERT INTO users (username, password_hash, google_id) VALUES (?, '!', ?)"),
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
  deleteUserData:      db.prepare('DELETE FROM profiles WHERE user_id = ?'),
  deleteUserWorkouts:  db.prepare('DELETE FROM workouts WHERE user_id = ?'),
  deleteUserWeights:   db.prepare('DELETE FROM weights WHERE user_id = ?'),
  deleteUserCalories:  db.prepare('DELETE FROM calories WHERE user_id = ?'),
  updateUserPassword:  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?'),
  listUsers:        db.prepare('SELECT id, username, role FROM users ORDER BY username COLLATE NOCASE'),
  getUserById:      db.prepare('SELECT id, username, role FROM users WHERE id = ?'),
  updateUserRole:   db.prepare('UPDATE users SET role = ? WHERE id = ?'),
  updateUsername:   db.prepare('UPDATE users SET username = ? WHERE id = ?'),
  deleteUser:       db.prepare('DELETE FROM users WHERE id = ?'),
  assignTrainer:    db.prepare('INSERT OR IGNORE INTO trainer_assignments (trainer_id, user_id) VALUES (?, ?)'),
  removeAssignment: db.prepare('DELETE FROM trainer_assignments WHERE trainer_id = ? AND user_id = ?'),
  getAssignedUsers: db.prepare('SELECT u.id, u.username, u.role FROM users u JOIN trainer_assignments ta ON ta.user_id = u.id WHERE ta.trainer_id = ? ORDER BY u.username COLLATE NOCASE'),
  isAssigned:       db.prepare('SELECT 1 FROM trainer_assignments WHERE trainer_id = ? AND user_id = ?'),
  // Plans
  getTrainerPlans:    db.prepare('SELECT id, data FROM plans WHERE trainer_id = ? ORDER BY rowid'),
  insertPlan:         db.prepare('INSERT INTO plans (id, trainer_id, name, data) VALUES (?, ?, ?, ?)'),
  updatePlan:         db.prepare('UPDATE plans SET name = ?, data = ? WHERE id = ? AND trainer_id = ?'),
  deletePlan:         db.prepare('DELETE FROM plans WHERE id = ? AND trainer_id = ?'),
  getPlanById:        db.prepare('SELECT id, trainer_id, data FROM plans WHERE id = ?'),
  assignPlan:         db.prepare('INSERT OR IGNORE INTO plan_assignments (plan_id, user_id) VALUES (?, ?)'),
  unassignPlan:       db.prepare('DELETE FROM plan_assignments WHERE plan_id = ? AND user_id = ?'),
  getPlanAssignments: db.prepare('SELECT u.id, u.username FROM users u JOIN plan_assignments pa ON pa.user_id = u.id WHERE pa.plan_id = ? ORDER BY u.username COLLATE NOCASE'),
  getUserPlans:       db.prepare('SELECT p.id, p.data FROM plans p JOIN plan_assignments pa ON pa.plan_id = p.id WHERE pa.user_id = ? ORDER BY p.rowid'),
  // Scheduled workouts
  getSchedule:            db.prepare('SELECT id, user_id, date, plan_id, title, notes FROM scheduled_workouts WHERE user_id = ? ORDER BY date'),
  getScheduleForMonth:    db.prepare('SELECT id, user_id, date, plan_id, title, notes FROM scheduled_workouts WHERE user_id = ? AND date >= ? AND date <= ? ORDER BY date'),
  insertSchedule:         db.prepare('INSERT INTO scheduled_workouts (id, user_id, date, plan_id, title, notes) VALUES (?, ?, ?, ?, ?, ?)'),
  updateSchedule:         db.prepare('UPDATE scheduled_workouts SET date = ?, plan_id = ?, title = ?, notes = ? WHERE id = ? AND user_id = ?'),
  deleteSchedule:         db.prepare('DELETE FROM scheduled_workouts WHERE id = ? AND user_id = ?'),
  getScheduleById:        db.prepare('SELECT id, user_id, date, plan_id, title, notes FROM scheduled_workouts WHERE id = ?'),
  deleteScheduleTrainer:  db.prepare('DELETE FROM scheduled_workouts WHERE id = ?'),
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

// ── Role middleware ───────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  const user = stmts.getUserById.get(req.user.userId);
  if (!user || user.role !== 'admin') return res.status(403).json({ error: 'Admin access required.' });
  req.user.role = user.role;
  next();
}

function requireTrainer(req, res, next) {
  const user = stmts.getUserById.get(req.user.userId);
  if (!user || (user.role !== 'trainer' && user.role !== 'admin')) {
    return res.status(403).json({ error: 'Trainer access required.' });
  }
  req.user.role = user.role;
  next();
}

function trainerCanAccessUser(req, res, next) {
  const targetId = parseInt(req.params.id, 10);
  if (!Number.isFinite(targetId)) return res.status(400).json({ error: 'Invalid user id.' });
  req.targetUserId = targetId;
  if (req.user.role === 'admin') return next();
  if (!stmts.isAssigned.get(req.user.userId, targetId)) {
    return res.status(403).json({ error: 'User not assigned to you.' });
  }
  next();
}

// ── Auth routes ─────────────────────────────────────────────────────────────────

// Helper: verify a Google ID token via Google's tokeninfo endpoint.
// For production deployments with high traffic, consider replacing this with
// local verification using the 'google-auth-library' package to avoid the
// round-trip to Google and potential rate limits on the tokeninfo endpoint.
async function verifyGoogleToken(idToken) {
  const url = `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error('Failed to verify Google token');
  const payload = await response.json();
  if (payload.error_description) throw new Error(payload.error_description);
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (clientId && payload.aud !== clientId) throw new Error('Token not issued for this application');
  if (!payload.sub) throw new Error('Invalid Google token payload');
  return payload;
}

// Return public configuration (e.g. Google Client ID) for the frontend
app.get('/api/config', (req, res) => {
  res.json({ googleClientId: process.env.GOOGLE_CLIENT_ID || null });
});

app.post('/api/auth/google', async (req, res) => {
  const { credential } = req.body || {};
  if (!credential) return res.status(400).json({ error: 'Google credential is required.' });

  try {
    const payload = await verifyGoogleToken(credential);
    const googleId = payload.sub;

    // Find existing user linked to this Google account
    let user = stmts.findUserByGoogleId.get(googleId);

    if (!user) {
      // Derive a username from the Google email address
      const emailPrefix = (payload.email || '').split('@')[0];
      let baseUsername = emailPrefix.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 28) || 'user';
      if (baseUsername.length < 2) baseUsername = 'user';

      // Ensure username is unique by appending a numeric suffix if necessary
      let username = baseUsername;
      let suffix = 1;
      while (stmts.findUser.get(username) && suffix <= 9999) {
        username = `${baseUsername.slice(0, 26)}_${suffix++}`;
      }

      const info = stmts.insertGoogleUser.run(username, googleId);
      user = { id: info.lastInsertRowid, username, role: 'user' };
    }

    const token = jwt.sign(
      { userId: user.id, username: user.username, role: user.role || 'user' },
      JWT_SECRET,
      { expiresIn: '7d' }
    );
    res.json({ token });
  } catch (err) {
    console.error('Google auth error:', err.message || err);
    res.status(401).json({ error: 'Google authentication failed.' });
  }
});

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
  const token = jwt.sign({ userId: info.lastInsertRowid, username, role: 'user' }, JWT_SECRET, { expiresIn: '7d' });
  res.status(201).json({ token });
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required.' });
  const user = stmts.findUser.get(username);
  if (!user) return res.status(401).json({ error: 'User not found.' });
  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) return res.status(401).json({ error: 'Incorrect password.' });
  const token = jwt.sign({ userId: user.id, username: user.username, role: user.role || 'user' }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token });
});

// ── Current user info ───────────────────────────────────────────────────────────
app.get('/api/user/me', requireAuth, (req, res) => {
  const user = stmts.getUserById.get(req.user.userId);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  res.json({ userId: user.id, username: user.username, role: user.role });
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
    stmts.deleteUserData.run(uid);
    stmts.deleteUserWorkouts.run(uid);
    stmts.deleteUserWeights.run(uid);
    stmts.deleteUserCalories.run(uid);
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
    const url = `https://world.openfoodfacts.org/api/v2/search?search_terms=${encodeURIComponent(query)}&page_size=20&fields=product_name,product_name_en,nutriments&lc=en`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'GetUsFit/1.0 (fitness tracking app)' },
      signal: AbortSignal.timeout(8000),
    });

    if (!response.ok) throw new Error('Upstream API error');
    const json = await response.json();

    const results = (json.products || [])
      .filter(p => !!(p.product_name_en || p.product_name))
      .map(p => ({
        name:     p.product_name_en || p.product_name,
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

// ── Admin routes ──────────────────────────────────────────────────────────────
app.get('/api/admin/users', requireAuth, requireAdmin, (req, res) => {
  res.json(stmts.listUsers.all());
});

app.post('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
  const { username, password, role = 'user' } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required.' });
  if (!/^[a-zA-Z0-9_]{2,30}$/.test(username)) {
    return res.status(400).json({ error: 'Username must be 2–30 characters (letters, numbers, underscores).' });
  }
  if (typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }
  if (!VALID_ROLES.includes(role)) {
    return res.status(400).json({ error: `Role must be one of: ${VALID_ROLES.join(', ')}.` });
  }
  if (stmts.findUser.get(username)) {
    return res.status(409).json({ error: 'Username already taken.' });
  }
  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const info = stmts.insertUserWithRole.run(username, hash, role);
  res.status(201).json({ ok: true, id: info.lastInsertRowid });
});

app.put('/api/admin/users/:id', requireAuth, requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid user id.' });

  const { username, role, password } = req.body || {};

  if (!stmts.getUserById.get(id)) return res.status(404).json({ error: 'User not found.' });

  if (username !== undefined) {
    if (!/^[a-zA-Z0-9_]{2,30}$/.test(username)) {
      return res.status(400).json({ error: 'Username must be 2–30 characters (letters, numbers, underscores).' });
    }
    const existing = stmts.findUser.get(username);
    if (existing && existing.id !== id) {
      return res.status(409).json({ error: 'Username already taken.' });
    }
    stmts.updateUsername.run(username, id);
  }

  if (role !== undefined) {
    if (!VALID_ROLES.includes(role)) {
      return res.status(400).json({ error: `Role must be one of: ${VALID_ROLES.join(', ')}.` });
    }
    stmts.updateUserRole.run(role, id);
  }

  if (password !== undefined) {
    if (typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }
    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    stmts.updateUserPassword.run(hash, id);
  }

  res.json({ ok: true });
});

app.delete('/api/admin/users/:id', requireAuth, requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid user id.' });
  if (id === req.user.userId) return res.status(400).json({ error: 'Cannot delete your own account.' });
  const info = stmts.deleteUser.run(id);
  if (info.changes === 0) return res.status(404).json({ error: 'User not found.' });
  res.json({ ok: true });
});

app.post('/api/admin/assignments', requireAuth, requireAdmin, (req, res) => {
  const { trainerId, userId } = req.body || {};
  if (!trainerId || !userId) return res.status(400).json({ error: 'trainerId and userId are required.' });
  const trainer = stmts.getUserById.get(trainerId);
  if (!trainer || trainer.role !== 'trainer') {
    return res.status(400).json({ error: 'Specified user is not a trainer.' });
  }
  if (!stmts.getUserById.get(userId)) return res.status(404).json({ error: 'User not found.' });
  stmts.assignTrainer.run(trainerId, userId);
  res.status(201).json({ ok: true });
});

app.delete('/api/admin/assignments/:trainerId/:userId', requireAuth, requireAdmin, (req, res) => {
  const trainerId = parseInt(req.params.trainerId, 10);
  const userId    = parseInt(req.params.userId, 10);
  if (!Number.isFinite(trainerId) || !Number.isFinite(userId)) {
    return res.status(400).json({ error: 'Invalid id.' });
  }
  const info = stmts.removeAssignment.run(trainerId, userId);
  if (info.changes === 0) return res.status(404).json({ error: 'Assignment not found.' });
  res.json({ ok: true });
});

app.get('/api/admin/assignments/:trainerId', requireAuth, requireAdmin, (req, res) => {
  const trainerId = parseInt(req.params.trainerId, 10);
  if (!Number.isFinite(trainerId)) return res.status(400).json({ error: 'Invalid trainer id.' });
  const trainer = stmts.getUserById.get(trainerId);
  if (!trainer || trainer.role !== 'trainer') {
    return res.status(400).json({ error: 'Specified user is not a trainer.' });
  }
  res.json(stmts.getAssignedUsers.all(trainerId));
});

// ── Trainer routes ────────────────────────────────────────────────────────────
app.get('/api/trainer/users', requireAuth, requireTrainer, (req, res) => {
  if (req.user.role === 'admin') return res.json(stmts.listUsers.all());
  res.json(stmts.getAssignedUsers.all(req.user.userId));
});

app.get('/api/trainer/users/:id/profile', requireAuth, requireTrainer, trainerCanAccessUser, (req, res) => {
  const row = stmts.getProfile.get(req.targetUserId);
  res.json(row ? JSON.parse(row.data) : null);
});

app.get('/api/trainer/users/:id/workouts', requireAuth, requireTrainer, trainerCanAccessUser, (req, res) => {
  const rows = stmts.getWorkouts.all(req.targetUserId);
  res.json(rows.map(r => JSON.parse(r.data)));
});

app.get('/api/trainer/users/:id/weights', requireAuth, requireTrainer, trainerCanAccessUser, (req, res) => {
  const rows = stmts.getWeights.all(req.targetUserId);
  res.json(rows.map(r => JSON.parse(r.data)));
});

app.get('/api/trainer/users/:id/calories', requireAuth, requireTrainer, trainerCanAccessUser, (req, res) => {
  const rows = stmts.getCalories.all(req.targetUserId);
  res.json(rows.map(r => ({ ...JSON.parse(r.data), id: r.id })));
});

// ── Trainer plan routes ───────────────────────────────────────────────────────
app.get('/api/trainer/plans', requireAuth, requireTrainer, (req, res) => {
  const rows = stmts.getTrainerPlans.all(req.user.userId);
  res.json(rows.map(r => JSON.parse(r.data)));
});

app.post('/api/trainer/plans', requireAuth, requireTrainer, (req, res) => {
  const plan = req.body;
  if (!plan || !plan.name || !Array.isArray(plan.exercises)) {
    return res.status(400).json({ error: 'Plan name and exercises are required.' });
  }
  const id = crypto.randomUUID();
  plan.id = id;
  plan.trainerId = req.user.userId;
  stmts.insertPlan.run(id, req.user.userId, plan.name, JSON.stringify(plan));
  res.status(201).json({ ok: true, id });
});

app.put('/api/trainer/plans/:id', requireAuth, requireTrainer, (req, res) => {
  const plan = req.body;
  if (!plan || !plan.name || !Array.isArray(plan.exercises)) {
    return res.status(400).json({ error: 'Plan name and exercises are required.' });
  }
  plan.id = req.params.id;
  plan.trainerId = req.user.userId;
  const info = stmts.updatePlan.run(plan.name, JSON.stringify(plan), req.params.id, req.user.userId);
  if (info.changes === 0) return res.status(404).json({ error: 'Plan not found.' });
  res.json({ ok: true });
});

app.delete('/api/trainer/plans/:id', requireAuth, requireTrainer, (req, res) => {
  const info = stmts.deletePlan.run(req.params.id, req.user.userId);
  if (info.changes === 0) return res.status(404).json({ error: 'Plan not found.' });
  res.json({ ok: true });
});

app.get('/api/trainer/plans/:id/assignments', requireAuth, requireTrainer, (req, res) => {
  const plan = stmts.getPlanById.get(req.params.id);
  if (!plan) return res.status(404).json({ error: 'Plan not found.' });
  if (req.user.role !== 'admin' && plan.trainer_id !== req.user.userId) {
    return res.status(403).json({ error: 'Access denied.' });
  }
  res.json(stmts.getPlanAssignments.all(req.params.id));
});

app.post('/api/trainer/plans/:id/assign', requireAuth, requireTrainer, (req, res) => {
  const plan = stmts.getPlanById.get(req.params.id);
  if (!plan) return res.status(404).json({ error: 'Plan not found.' });
  if (req.user.role !== 'admin' && plan.trainer_id !== req.user.userId) {
    return res.status(403).json({ error: 'Access denied.' });
  }
  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ error: 'userId is required.' });
  if (!stmts.getUserById.get(userId)) return res.status(404).json({ error: 'User not found.' });
  if (req.user.role !== 'admin' && !stmts.isAssigned.get(req.user.userId, userId)) {
    return res.status(403).json({ error: 'User not assigned to you.' });
  }
  stmts.assignPlan.run(req.params.id, userId);
  res.status(201).json({ ok: true });
});

app.delete('/api/trainer/plans/:id/assign/:userId', requireAuth, requireTrainer, (req, res) => {
  const plan = stmts.getPlanById.get(req.params.id);
  if (!plan) return res.status(404).json({ error: 'Plan not found.' });
  if (req.user.role !== 'admin' && plan.trainer_id !== req.user.userId) {
    return res.status(403).json({ error: 'Access denied.' });
  }
  const userId = parseInt(req.params.userId, 10);
  if (!Number.isFinite(userId)) return res.status(400).json({ error: 'Invalid user id.' });
  const info = stmts.unassignPlan.run(req.params.id, userId);
  if (info.changes === 0) return res.status(404).json({ error: 'Assignment not found.' });
  res.json({ ok: true });
});

// ── User plans route ──────────────────────────────────────────────────────────
// Optional ?userId=X allows trainers/admins to view an athlete's assigned plans
app.get('/api/user/plans', requireAuth, (req, res) => {
  let targetUserId = req.user.userId;
  if (req.query.userId) {
    const requester = stmts.getUserById.get(req.user.userId);
    if (!requester || (requester.role !== 'trainer' && requester.role !== 'admin')) {
      return res.status(403).json({ error: 'Access denied.' });
    }
    const targetId = parseInt(req.query.userId, 10);
    if (isNaN(targetId)) return res.status(400).json({ error: 'Invalid userId parameter.' });
    if (requester.role === 'trainer' && !stmts.isAssigned.get(req.user.userId, targetId)) {
      return res.status(403).json({ error: 'User not assigned to you.' });
    }
    targetUserId = targetId;
  }
  const rows = stmts.getUserPlans.all(targetUserId);
  res.json(rows.map(r => JSON.parse(r.data)));
});

// ── Barcode lookup ────────────────────────────────────────────────────────────
app.get('/api/food/barcode/:barcode', requireAuth, async (req, res) => {
  const barcode = req.params.barcode.trim();
  if (!/^\d{6,14}$/.test(barcode)) {
    return res.status(400).json({ error: 'Invalid barcode format.' });
  }

  try {
    const url = `https://uk.openfoodfacts.org/api/v2/product/${encodeURIComponent(barcode)}.json?fields=product_name,product_name_en,nutriments&lc=en`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'GetUsFit/1.0 (fitness tracking app)' },
      signal: AbortSignal.timeout(8000),
    });

    if (!response.ok) throw new Error('Upstream API error');
    const json = await response.json();

    if (json.status !== 1 || !json.product) {
      return res.status(404).json({ error: 'Product not found for this barcode.' });
    }

    const p = json.product;
    res.json({
      name:     p.product_name_en || p.product_name || 'Unknown product',
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

// ── Schedule routes ───────────────────────────────────────────────────────────

// GET /api/schedule  – returns all scheduled workouts for the current user
// Optional query params: ?from=YYYY-MM-DD&to=YYYY-MM-DD to filter by date range
// Optional ?userId=X allows trainers/admins to view an athlete's schedule
app.get('/api/schedule', requireAuth, (req, res) => {
  const { from, to } = req.query;
  let targetUserId = req.user.userId;
  if (req.query.userId) {
    const requester = stmts.getUserById.get(req.user.userId);
    if (!requester || (requester.role !== 'trainer' && requester.role !== 'admin')) {
      return res.status(403).json({ error: 'Access denied.' });
    }
    const targetId = parseInt(req.query.userId, 10);
    if (isNaN(targetId)) return res.status(400).json({ error: 'Invalid userId parameter.' });
    if (requester.role === 'trainer' && !stmts.isAssigned.get(req.user.userId, targetId)) {
      return res.status(403).json({ error: 'User not assigned to you.' });
    }
    targetUserId = targetId;
  }
  if (from && to) {
    const rows = stmts.getScheduleForMonth.all(targetUserId, from, to);
    return res.json(rows);
  }
  res.json(stmts.getSchedule.all(targetUserId));
});

// POST /api/schedule  – create a new scheduled workout entry
app.post('/api/schedule', requireAuth, (req, res) => {
  const { date, title, planId = null, notes = '' } = req.body || {};
  if (!date || !title) {
    return res.status(400).json({ error: 'date and title are required.' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'date must be in YYYY-MM-DD format.' });
  }
  if (planId !== null && planId !== undefined) {
    const plan = stmts.getPlanById.get(planId);
    if (!plan) return res.status(404).json({ error: 'Plan not found.' });
  }
  const id = crypto.randomUUID();
  stmts.insertSchedule.run(id, req.user.userId, date, planId || null, String(title).trim(), String(notes).trim());
  res.status(201).json({ ok: true, id });
});

// PUT /api/schedule/:id  – update a scheduled workout entry
app.put('/api/schedule/:id', requireAuth, (req, res) => {
  const existing = stmts.getScheduleById.get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Scheduled workout not found.' });
  if (existing.user_id !== req.user.userId) return res.status(403).json({ error: 'Access denied.' });

  const { date, title, planId = existing.plan_id, notes = existing.notes } = req.body || {};
  if (!date || !title) {
    return res.status(400).json({ error: 'date and title are required.' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'date must be in YYYY-MM-DD format.' });
  }
  stmts.updateSchedule.run(date, planId || null, String(title).trim(), String(notes).trim(), req.params.id, req.user.userId);
  res.json({ ok: true });
});

// DELETE /api/schedule/:id  – delete a scheduled workout entry
app.delete('/api/schedule/:id', requireAuth, (req, res) => {
  const existing = stmts.getScheduleById.get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Scheduled workout not found.' });
  if (existing.user_id !== req.user.userId) {
    // Allow trainers to delete entries they scheduled for athletes
    const user = stmts.getUserById.get(req.user.userId);
    if (!user || (user.role !== 'trainer' && user.role !== 'admin')) {
      return res.status(403).json({ error: 'Access denied.' });
    }
    if (user.role === 'trainer' && !stmts.isAssigned.get(req.user.userId, existing.user_id)) {
      return res.status(403).json({ error: 'User not assigned to you.' });
    }
    stmts.deleteScheduleTrainer.run(req.params.id);
    return res.json({ ok: true });
  }
  stmts.deleteSchedule.run(req.params.id, req.user.userId);
  res.json({ ok: true });
});

// POST /api/schedule/:id/complete  – mark a scheduled workout as completed by creating a workout entry
app.post('/api/schedule/:id/complete', requireAuth, (req, res) => {
  const scheduled = stmts.getScheduleById.get(req.params.id);
  if (!scheduled) return res.status(404).json({ error: 'Scheduled workout not found.' });
  if (scheduled.user_id !== req.user.userId) return res.status(403).json({ error: 'Access denied.' });

  const notes = [scheduled.title, scheduled.notes].filter(Boolean).join(' – ');
  let exercises = [];
  if (scheduled.plan_id) {
    const plan = stmts.getPlanById.get(scheduled.plan_id);
    if (plan) {
      try {
        exercises = JSON.parse(plan.data).exercises || [];
      } catch (_) {
        exercises = [];
      }
    }
  }
  const workoutId = crypto.randomUUID();
  const session = { id: workoutId, date: scheduled.date, notes, exercises };
  stmts.insertWorkout.run(workoutId, req.user.userId, scheduled.date, JSON.stringify(session));
  res.status(201).json({ ok: true, workoutId });
});

// POST /api/trainer/schedule  – trainer schedules a workout for an athlete
app.post('/api/trainer/schedule', requireAuth, requireTrainer, (req, res) => {
  const { userId, date, title, planId = null, notes = '' } = req.body || {};
  if (!userId || !date || !title) {
    return res.status(400).json({ error: 'userId, date and title are required.' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'date must be in YYYY-MM-DD format.' });
  }
  const targetUser = stmts.getUserById.get(userId);
  if (!targetUser) return res.status(404).json({ error: 'User not found.' });
  if (req.user.role !== 'admin' && !stmts.isAssigned.get(req.user.userId, userId)) {
    return res.status(403).json({ error: 'User not assigned to you.' });
  }
  if (planId !== null && planId !== undefined) {
    const plan = stmts.getPlanById.get(planId);
    if (!plan) return res.status(404).json({ error: 'Plan not found.' });
  }
  const id = crypto.randomUUID();
  stmts.insertSchedule.run(id, userId, date, planId || null, String(title).trim(), String(notes).trim());
  res.status(201).json({ ok: true, id });
});

// ── Start server ─────────────────────────────────────────────────────────────────
if (require.main === module) {
  const server = app.listen(PORT, () => {
    console.log(`GetUs.Fit server running on http://localhost:${PORT}`);
  });
  server.on('error', (err) => {
    console.error(`[GetUs.Fit] Failed to start server: ${err.message}`);
    process.exit(1);
  });
}

module.exports = app;
module.exports.db = db;
