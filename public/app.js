/**
 * GetUs.Fit – shared utilities
 * Uses a REST API backend to persist data server-side.
 */

const API = {
  BASE: '/api',

  /** Return the stored JWT token */
  token() {
    return sessionStorage.getItem('dgf_token');
  },

  /** Make an authenticated fetch request */
  async request(method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    const token = this.token();
    if (token) headers['Authorization'] = 'Bearer ' + token;

    let res;
    try {
      res = await fetch(this.BASE + path, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new Error('Cannot reach the server. Please make sure the backend is running.');
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  },

  get(path)        { return this.request('GET',    path); },
  post(path, body) { return this.request('POST',   path, body); },
  put(path, body)  { return this.request('PUT',    path, body); },
  del(path)        { return this.request('DELETE', path); },
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

const Auth = {
  TOKEN_KEY: 'dgf_token',

  /** Decode the JWT payload without verification (client-side read only) */
  _payload() {
    const token = sessionStorage.getItem(this.TOKEN_KEY);
    if (!token) return null;
    try {
      return JSON.parse(atob(token.split('.')[1]));
    } catch { return null; }
  },

  /** Returns the current username string, or null if not logged in */
  currentUser() {
    const p = this._payload();
    if (!p) return null;
    // Check expiry
    if (p.exp && Date.now() / 1000 > p.exp) {
      sessionStorage.removeItem(this.TOKEN_KEY);
      return null;
    }
    return p.username || null;
  },

  /** Returns the current user's role ('admin', 'trainer', 'user'), or null */
  role() {
    const p = this._payload();
    return p ? (p.role || 'user') : null;
  },

  async register(username, password) {
    try {
      const { token } = await API.post('/auth/register', { username, password });
      sessionStorage.setItem(this.TOKEN_KEY, token);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  },

  async login(username, password) {
    try {
      const { token } = await API.post('/auth/login', { username, password });
      sessionStorage.setItem(this.TOKEN_KEY, token);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  },

  logout() {
    sessionStorage.removeItem(this.TOKEN_KEY);
    window.location.href = 'login.html';
  },

  /** Redirect to login.html if no active session; also populates the nav username badge */
  requireAuth() {
    if (!this.currentUser()) {
      window.location.href = 'login.html';
    }
    const el = document.getElementById('nav-username-display');
    if (el) el.textContent = this.currentUser();

    // Inject Admin link for admin/trainer roles
    const role = this.role();
    if (role === 'admin' || role === 'trainer') {
      const existing = document.getElementById('nav-admin-link');
      if (!existing) {
        const nav = document.querySelector('nav');
        if (nav) {
          const link = document.createElement('a');
          link.id   = 'nav-admin-link';
          link.href = 'admin.html';
          link.textContent = role === 'admin' ? '⚙ Admin' : '👥 My Athletes';
          if (window.location.pathname.endsWith('admin.html')) link.classList.add('active');
          // Insert before the nav-user div
          const navUser = nav.querySelector('.nav-user');
          nav.insertBefore(link, navUser || null);
        }
      }
    }
  },
};
