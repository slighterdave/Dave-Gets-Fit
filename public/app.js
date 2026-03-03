/**
 * GetUs.Fit – shared utilities
 * Uses a REST API backend to persist data server-side.
 */

// ── Exercise catalogue ────────────────────────────────────────────────────────
const EXERCISE_CATALOGUE = {
  'Lower body (squat / knee-dominant)': [
    'Back squat (barbell)',
    'Front squat (barbell)',
    'Goblet squat (dumbbell/kettlebell)',
    'Bulgarian split squat (DB/BB)',
    'Leg press (machine)',
    'Hack squat (machine)',
    'Smith machine squat',
    'Step-up (DB)',
    'Walking lunge (DB/BB)',
    'Reverse lunge (DB/BB)',
    'Leg extension (machine)',
  ],
  'Lower body (hinge / posterior chain)': [
    'Deadlift (conventional)',
    'Sumo deadlift',
    'Romanian deadlift (barbell)',
    'Romanian deadlift (dumbbells)',
    'Trap bar deadlift',
    'Good morning (barbell)',
    'Hip thrust (barbell)',
    'Glute bridge (barbell)',
    'Kettlebell swing',
    'Cable pull-through',
    'Back extension (weighted)',
  ],
  'Upper body push (chest/shoulders/triceps)': [
    'Bench press (barbell)',
    'Incline bench press (barbell)',
    'Dumbbell bench press',
    'Incline dumbbell press',
    'Chest press (machine)',
    'Overhead press (barbell)',
    'Dumbbell shoulder press',
    'Arnold press',
    'Lateral raise (dumbbells/cable)',
    'Front raise (dumbbells/plate)',
    'Triceps pushdown (cable)',
    'Overhead triceps extension (DB/cable)',
    'Skull crushers (EZ-bar)',
  ],
  'Upper body pull (back/biceps)': [
    'Bent-over row (barbell)',
    'One-arm dumbbell row',
    'Seated cable row',
    'Lat pulldown (machine)',
    'T-bar row',
    'Chest-supported row (machine/DB)',
    'Pull-up (weighted)',
    'Chin-up (weighted)',
    'Face pull (cable)',
    'Rear delt fly (DB/cable)',
    'Barbell curl',
    'Dumbbell curl',
    'Hammer curl',
    'Preacher curl (machine/EZ-bar)',
  ],
  'Calves': [
    'Standing calf raise (machine/Smith/DB)',
    'Seated calf raise (machine)',
    'Single-leg calf raise (weighted)',
  ],
  'Core (weighted)': [
    'Cable crunch',
    'Weighted sit-up',
    'Decline sit-up (weighted)',
    'Hanging knee/leg raise',
    'Pallof press (cable/band)',
    'Weighted Russian twist',
    'Farmers carry (DB/KB)',
    'Suitcase carry',
  ],
  'Full-body / power / carries': [
    'Power clean',
    'Hang clean',
    'Clean and press',
    'Push press',
    'Thruster (barbell/dumbbells)',
    'Dumbbell snatch',
    'Kettlebell clean',
    'Farmers walk',
    'Sandbag carry',
  ],
};

/**
 * Wire up the muscle-group → exercise cascade selectors on an exercise row.
 * If existingName is given, pre-selects the matching group + exercise (or
 * selects "Custom" and fills the text input for names not in the catalogue).
 */
function setupExerciseRow(div, existingName) {
  const groupSel = div.querySelector('.ex-group');
  const exSel    = div.querySelector('.ex-select');
  const nameIn   = div.querySelector('.ex-name');

  // Find which catalogue group (if any) contains the existing name
  let foundGroup = '';
  if (existingName) {
    for (const [g, exercises] of Object.entries(EXERCISE_CATALOGUE)) {
      if (exercises.includes(existingName)) { foundGroup = g; break; }
    }
  }

  function populateExercises(group) {
    exSel.innerHTML = '<option value="">Select exercise\u2026</option>' +
      (EXERCISE_CATALOGUE[group] || [])
        .map(e => '<option value="' + escHtmlShared(e) + '">' + escHtmlShared(e) + '</option>')
        .join('');
  }

  function onGroupChange() {
    const g = groupSel.value;
    if (g && g !== '__custom__') {
      populateExercises(g);
      exSel.style.display = '';
      nameIn.style.display = 'none';
      nameIn.value = '';
    } else {
      exSel.style.display = 'none';
      exSel.value = '';
      nameIn.style.display = '';
    }
  }

  groupSel.addEventListener('change', onGroupChange);

  // Initialise from existing name
  if (foundGroup) {
    groupSel.value = foundGroup;
    populateExercises(foundGroup);
    exSel.style.display = '';
    nameIn.style.display = 'none';
    for (let i = 0; i < exSel.options.length; i++) {
      if (exSel.options[i].value === existingName) { exSel.options[i].selected = true; break; }
    }
  } else if (existingName) {
    groupSel.value = '__custom__';
    exSel.style.display = 'none';
    nameIn.style.display = '';
    nameIn.value = existingName;
  }
  // else: blank state – text input visible for free-form entry
}

/**
 * Read the exercise name from a row div (works with both catalogue and custom).
 */
function getExerciseName(row) {
  const exSel  = row.querySelector('.ex-select');
  const nameIn = row.querySelector('.ex-name');
  if (exSel && exSel.style.display !== 'none' && exSel.value) return exSel.value;
  return nameIn ? nameIn.value.trim() : '';
}

/** Escape HTML special characters to prevent XSS */
function escHtmlShared(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

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

  /** Fetch without requiring authentication (used for public config endpoints) */
  async getRaw(path) {
    let res;
    try {
      res = await fetch(this.BASE + path, { headers: { 'Content-Type': 'application/json' } });
    } catch {
      throw new Error('Cannot reach the server.');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
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

const Auth = {
  TOKEN_KEY: 'dgf_token',

  /** Decode the JWT payload without verification (client-side read only) */
  _payload() {
    const token = sessionStorage.getItem(this.TOKEN_KEY);
    if (!token) return null;
    try {
      // JWT uses base64url encoding; atob() requires standard base64.
      // Convert by replacing url-safe chars and restoring stripped padding.
      const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      const padded = b64 + '='.repeat((4 - b64.length % 4) % 4);
      return JSON.parse(atob(padded));
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

  async loginWithGoogle(credential) {
    try {
      const { token } = await API.post('/auth/google', { credential });
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

  /** Inject/refresh role-based nav links based on the given role string */
  _injectNavLinks(role) {
    ['nav-admin-link', 'nav-plans-link', 'nav-routines-link'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.remove();
    });

    // My Routines link – visible to all authenticated users
    const navLinks = document.getElementById('nav-links');
    if (navLinks && !navLinks.querySelector('a[href="my-routines.html"]')) {
      const routinesLink = document.createElement('a');
      routinesLink.id = 'nav-routines-link';
      routinesLink.href = 'my-routines.html';
      routinesLink.textContent = 'My Routines';
      if (window.location.pathname.endsWith('my-routines.html')) routinesLink.classList.add('active');
      navLinks.appendChild(routinesLink);
    }

    if (role === 'admin' || role === 'trainer') {
      if (navLinks) {
        const link = document.createElement('a');
        link.id   = 'nav-admin-link';
        link.href = 'admin.html';
        link.textContent = role === 'admin' ? 'Admin' : 'My Athletes';
        if (window.location.pathname.endsWith('admin.html')) link.classList.add('active');
        navLinks.appendChild(link);
      }
    }

    if (role === 'trainer' || role === 'admin') {
      if (navLinks) {
        const link = document.createElement('a');
        link.id   = 'nav-plans-link';
        link.href = 'trainer-plans.html';
        link.textContent = 'Plans';
        if (window.location.pathname.endsWith('trainer-plans.html')) link.classList.add('active');
        navLinks.appendChild(link);
      }
    }
  },

  /** Redirect to login.html if no active session; also populates the nav username badge */
  requireAuth() {
    if (!this.currentUser()) {
      window.location.href = 'login.html';
      return;
    }
    const el = document.getElementById('nav-username-display');
    if (el) el.textContent = this.currentUser();

    // Burger menu toggle
    const burger = document.getElementById('nav-burger');
    const navLinks = document.getElementById('nav-links');
    if (burger && navLinks) {
      burger.addEventListener('click', () => {
        const isOpen = navLinks.classList.toggle('open');
        burger.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
      });
    }

    // Inject nav links based on JWT role initially, then refresh from server
    // to pick up any role changes made since the token was issued.
    this._injectNavLinks(this.role());
    API.get('/user/me').then(me => {
      if (me.role !== this.role()) {
        this._injectNavLinks(me.role);
      }
    }).catch(err => console.warn('Could not refresh role from server:', err.message));
  },
};
