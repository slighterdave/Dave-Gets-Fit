/**
 * Dave Gets Fit – shared utilities
 * Uses localStorage so data persists between sessions.
 */

const Storage = {
  get(key) {
    try {
      return JSON.parse(localStorage.getItem(key)) || [];
    } catch {
      return [];
    }
  },
  set(key, data) {
    localStorage.setItem(key, JSON.stringify(data));
  },
};

/** Return today's date as YYYY-MM-DD */
function today() {
  return new Date().toISOString().split('T')[0];
}

/** Format a YYYY-MM-DD string for display */
function formatDate(dateStr) {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-');
  return `${d}/${m}/${y}`;
}

/** Show a temporary success banner above the given container */
function showAlert(container, message, type = 'success') {
  const existing = container.querySelector('.alert');
  if (existing) existing.remove();

  const div = document.createElement('div');
  div.className = `alert alert-${type}`;
  div.textContent = message;
  container.prepend(div);
  setTimeout(() => div.remove(), 3000);
}

/** SHA-256 hash via Web Crypto API – used for client-side credential storage */
async function hashPassword(str) {
  const encoded = new TextEncoder().encode(str);
  const buf = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

const Auth = {
  USERS_KEY:   'dgf_users',
  SESSION_KEY: 'dgf_session',

  _users() {
    try { return JSON.parse(localStorage.getItem(this.USERS_KEY)) || []; }
    catch { return []; }
  },
  _saveUsers(users) {
    localStorage.setItem(this.USERS_KEY, JSON.stringify(users));
  },

  /** Returns the current username string, or null if not logged in */
  currentUser() {
    try { return JSON.parse(sessionStorage.getItem(this.SESSION_KEY)) || null; }
    catch { return null; }
  },

  async register(username, password) {
    if (!/^[a-zA-Z0-9_]{2,30}$/.test(username)) {
      return { ok: false, error: 'Username must be 2–30 characters (letters, numbers, underscores).' };
    }
    const users = this._users();
    if (users.find(u => u.username.toLowerCase() === username.toLowerCase())) {
      return { ok: false, error: 'Username already taken.' };
    }
    users.push({ username, passwordHash: await hashPassword(password) });
    this._saveUsers(users);
    return { ok: true };
  },

  async login(username, password) {
    const users = this._users();
    const user  = users.find(u => u.username.toLowerCase() === username.toLowerCase());
    if (!user) return { ok: false, error: 'User not found.' };
    if (user.passwordHash !== await hashPassword(password)) return { ok: false, error: 'Incorrect password.' };
    sessionStorage.setItem(this.SESSION_KEY, JSON.stringify(username));
    return { ok: true };
  },

  logout() {
    sessionStorage.removeItem(this.SESSION_KEY);
    window.location.href = 'login.html';
  },

  /** Redirect to login.html if no active session; also populates the nav username badge */
  requireAuth() {
    if (!this.currentUser()) {
      window.location.href = 'login.html';
    }
    const el = document.getElementById('nav-username-display');
    if (el) el.textContent = this.currentUser();
  },

  /** Namespace a storage key to the current user */
  userKey(key) {
    const u = this.currentUser();
    return u ? key + '_' + u : key;
  },
};
