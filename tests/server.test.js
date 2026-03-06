'use strict';

/**
 * Integration tests for the GetUs.Fit backend API.
 * Uses Node.js built-in test runner (node --test).
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http   = require('node:http');
const path   = require('node:path');
const fs     = require('node:fs');
const jwt    = require('jsonwebtoken');

// Use a temp database for tests
process.env.DB_PATH = path.join('/tmp', `dgf_test_${Date.now()}.db`);
process.env.JWT_SECRET = 'test-secret-for-unit-tests-only';
process.env.PORT = '0'; // Let OS pick a free port

// Load the app (it calls app.listen internally; we grab the server via module.exports)
const app = require('../server.js');
const { db } = app;

let server;
let baseUrl;

before(async () => {
  // server.js exports app (an express app). We start a fresh server for tests.
  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

after(async () => {
  server.close();
  // Clean up test database
  if (fs.existsSync(process.env.DB_PATH)) fs.unlinkSync(process.env.DB_PATH);
});

// ── Helper ────────────────────────────────────────────────────────────────────
async function req(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(baseUrl + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, body: data };
}

// ── Auth ──────────────────────────────────────────────────────────────────────
test('register a new user', async () => {
  const { status, body } = await req('POST', '/api/auth/register', { username: 'alice', password: 'password123' });
  assert.equal(status, 201);
  assert.ok(body.token, 'should return a JWT token');
});

test('register duplicate user returns 409', async () => {
  const { status } = await req('POST', '/api/auth/register', { username: 'alice', password: 'password123' });
  assert.equal(status, 409);
});

test('register with short password returns 400', async () => {
  const { status } = await req('POST', '/api/auth/register', { username: 'bob', password: 'short' });
  assert.equal(status, 400);
});

test('login with correct credentials', async () => {
  const { status, body } = await req('POST', '/api/auth/login', { username: 'alice', password: 'password123' });
  assert.equal(status, 200);
  assert.ok(body.token);
});

test('login with wrong password returns 401', async () => {
  const { status } = await req('POST', '/api/auth/login', { username: 'alice', password: 'wrong' });
  assert.equal(status, 401);
});

test('login with unknown user returns 401', async () => {
  const { status } = await req('POST', '/api/auth/login', { username: 'nobody', password: 'anything' });
  assert.equal(status, 401);
});

// ── Trust proxy / rate limiting ───────────────────────────────────────────────
test('trust proxy is set so rate limiting uses real client IP from X-Forwarded-For', async () => {
  // When trust proxy = 1 Express reads req.ip from X-Forwarded-For.
  // A spoofed header from a test client reaching the server directly is NOT
  // trusted (the header injected by *our* connection is the one that counts),
  // but we can at least confirm the Express setting is active: if trust proxy
  // were disabled, a request with X-Forwarded-For would still return a
  // successful response instead of being rate-limited by the proxy address.
  // The simplest observable check: a public endpoint responds normally even
  // when an X-Forwarded-For header is present (the app should not crash or
  // reject it because of the missing trust proxy configuration).
  const res = await fetch(baseUrl + '/api/config', {
    headers: { 'X-Forwarded-For': '203.0.113.1', 'Content-Type': 'application/json' },
  });
  assert.equal(res.status, 200, 'request with X-Forwarded-For header should succeed');

  // Verify the setting is present on the Express app itself.
  assert.equal(app.get('trust proxy'), 1, 'Express trust proxy must be set to 1 for the deployed nginx reverse-proxy setup');
});

// ── Google auth config ────────────────────────────────────────────────────────
test('GET /api/config returns googleClientId field', async () => {
  const { status, body } = await req('GET', '/api/config');
  assert.equal(status, 200);
  assert.ok('googleClientId' in body, 'response should include googleClientId field');
});

// ── Profile ───────────────────────────────────────────────────────────────────
test('get profile returns null when not set', async () => {
  const { body: loginBody } = await req('POST', '/api/auth/login', { username: 'alice', password: 'password123' });
  const token = loginBody.token;

  const { status, body } = await req('GET', '/api/profile', undefined, token);
  assert.equal(status, 200);
  assert.equal(body, null);
});

test('save and retrieve profile', async () => {
  const { body: loginBody } = await req('POST', '/api/auth/login', { username: 'alice', password: 'password123' });
  const token = loginBody.token;

  const profile = { firstName: 'Alice', lastName: 'Smith', email: 'alice@example.com', age: '30', goal: 'lose-weight' };
  const { status: putStatus } = await req('PUT', '/api/profile', profile, token);
  assert.equal(putStatus, 200);

  const { status, body } = await req('GET', '/api/profile', undefined, token);
  assert.equal(status, 200);
  assert.equal(body.firstName, 'Alice');
  assert.equal(body.email, 'alice@example.com');
});

test('profile requires auth', async () => {
  const { status } = await req('GET', '/api/profile');
  assert.equal(status, 401);
});

// ── Workouts ──────────────────────────────────────────────────────────────────
let aliceToken;

test('setup: login alice', async () => {
  const { body } = await req('POST', '/api/auth/login', { username: 'alice', password: 'password123' });
  aliceToken = body.token;
  assert.ok(aliceToken);
});

test('list workouts returns empty array initially', async () => {
  const { status, body } = await req('GET', '/api/workouts', undefined, aliceToken);
  assert.equal(status, 200);
  assert.deepEqual(body, []);
});

let workoutId;

test('log a workout', async () => {
  const workout = {
    date: '2025-01-15',
    notes: 'Felt great',
    exercises: [{ name: 'Bench Press', sets: '3', reps: '10', weightKg: '80' }],
  };
  const { status, body } = await req('POST', '/api/workouts', workout, aliceToken);
  assert.equal(status, 201);
  assert.ok(body.id);
  workoutId = body.id;
});

test('list workouts returns logged workout', async () => {
  const { status, body } = await req('GET', '/api/workouts', undefined, aliceToken);
  assert.equal(status, 200);
  assert.equal(body.length, 1);
  assert.equal(body[0].date, '2025-01-15');
  assert.equal(body[0].exercises[0].name, 'Bench Press');
});

test('delete a workout', async () => {
  const { status } = await req('DELETE', '/api/workouts/' + workoutId, undefined, aliceToken);
  assert.equal(status, 200);

  const { body } = await req('GET', '/api/workouts', undefined, aliceToken);
  assert.equal(body.length, 0);
});

// ── Weights ───────────────────────────────────────────────────────────────────
test('list weights returns empty array initially', async () => {
  const { status, body } = await req('GET', '/api/weights', undefined, aliceToken);
  assert.equal(status, 200);
  assert.deepEqual(body, []);
});

test('log a weight entry', async () => {
  const { status } = await req('POST', '/api/weights', { date: '2025-01-15', weight: '75.0', goal: '70.0', notes: 'Morning' }, aliceToken);
  assert.equal(status, 201);
});

test('log same date replaces previous entry (upsert)', async () => {
  await req('POST', '/api/weights', { date: '2025-01-15', weight: '74.5', goal: '70.0', notes: 'Evening' }, aliceToken);
  const { body } = await req('GET', '/api/weights', undefined, aliceToken);
  assert.equal(body.length, 1);
  assert.equal(body[0].weight, '74.5');
});

test('delete a weight entry', async () => {
  const { status } = await req('DELETE', '/api/weights/2025-01-15', undefined, aliceToken);
  assert.equal(status, 200);

  const { body } = await req('GET', '/api/weights', undefined, aliceToken);
  assert.equal(body.length, 0);
});

// ── Calories ──────────────────────────────────────────────────────────────────
test('list calories returns empty array initially', async () => {
  const { status, body } = await req('GET', '/api/calories', undefined, aliceToken);
  assert.equal(status, 200);
  assert.deepEqual(body, []);
});

let calorieId;

test('log a meal', async () => {
  const { status, body } = await req('POST', '/api/calories', {
    date: '2025-01-15', meal: 'Lunch', food: 'Chicken salad',
    calories: '400', protein: '35', carbs: '20', fat: '15', target: '2000',
  }, aliceToken);
  assert.equal(status, 201);
  assert.ok(body.id);
  calorieId = body.id;
});

test('list calories returns logged meal', async () => {
  const { status, body } = await req('GET', '/api/calories', undefined, aliceToken);
  assert.equal(status, 200);
  assert.equal(body.length, 1);
  assert.equal(body[0].food, 'Chicken salad');
  assert.ok(body[0].id, 'should include an id field');
});

test('delete a calorie entry', async () => {
  const { status } = await req('DELETE', '/api/calories/' + calorieId, undefined, aliceToken);
  assert.equal(status, 200);

  const { body } = await req('GET', '/api/calories', undefined, aliceToken);
  assert.equal(body.length, 0);
});

// ── One Rep Maxes ─────────────────────────────────────────────────────────────
test('get 1RM returns empty array initially', async () => {
  const { status, body } = await req('GET', '/api/1rm', undefined, aliceToken);
  assert.equal(status, 200);
  assert.deepEqual(body, []);
});

test('set a 1RM entry', async () => {
  const { status, body } = await req('PUT', '/api/1rm/Bench%20Press', { weightKg: 100 }, aliceToken);
  assert.equal(status, 200);
  assert.ok(body.ok);
});

test('get 1RM returns saved entry', async () => {
  const { status, body } = await req('GET', '/api/1rm', undefined, aliceToken);
  assert.equal(status, 200);
  assert.equal(body.length, 1);
  assert.equal(body[0].exercise, 'Bench Press');
  assert.equal(body[0].weight_kg, 100);
  assert.ok(body[0].updated_at);
});

test('updating a 1RM replaces previous value', async () => {
  await req('PUT', '/api/1rm/Bench%20Press', { weightKg: 110 }, aliceToken);
  const { body } = await req('GET', '/api/1rm', undefined, aliceToken);
  assert.equal(body.length, 1);
  assert.equal(body[0].weight_kg, 110);
});

test('set a second 1RM entry', async () => {
  const { status } = await req('PUT', '/api/1rm/Back%20squat', { weightKg: 140 }, aliceToken);
  assert.equal(status, 200);
  const { body } = await req('GET', '/api/1rm', undefined, aliceToken);
  assert.equal(body.length, 2);
});

test('set 1RM with invalid weight returns 400', async () => {
  const { status, body } = await req('PUT', '/api/1rm/Deadlift', { weightKg: -5 }, aliceToken);
  assert.equal(status, 400);
  assert.ok(body.error);
});

test('1RM requires auth', async () => {
  const { status } = await req('GET', '/api/1rm');
  assert.equal(status, 401);
});

test('delete a 1RM entry', async () => {
  const { status } = await req('DELETE', '/api/1rm/Bench%20Press', undefined, aliceToken);
  assert.equal(status, 200);
  const { body } = await req('GET', '/api/1rm', undefined, aliceToken);
  assert.equal(body.length, 1);
  assert.equal(body[0].exercise, 'Back squat');
});

test('delete non-existent 1RM returns 404', async () => {
  const { status } = await req('DELETE', '/api/1rm/Nonexistent', undefined, aliceToken);
  assert.equal(status, 404);
});

// ── Food search ───────────────────────────────────────────────────────────────
test('food search requires auth', async () => {
  const { status } = await req('GET', '/api/food/search?q=apple');
  assert.equal(status, 401);
});

test('food search returns 400 when query is missing', async () => {
  const { status, body } = await req('GET', '/api/food/search', undefined, aliceToken);
  assert.equal(status, 400);
  assert.ok(body.error);
});

test('food search uses USDA FoodData Central POST endpoint with all data types', async () => {
  app.foodSearchCache.clear();
  let capturedUrl = null;
  let capturedBody = null;
  let capturedMethod = null;
  const originalFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (typeof url === 'string' && new URL(url).hostname === 'api.nal.usda.gov') {
      capturedUrl = url;
      capturedMethod = opts?.method;
      capturedBody = opts?.body ? JSON.parse(opts.body) : null;
      return { ok: true, json: async () => ({ foods: [] }) };
    }
    return originalFetch(url, opts);
  };
  try {
    await req('GET', '/api/food/search?q=chicken', undefined, aliceToken);
    assert.ok(capturedUrl, 'fetch to USDA FDC should have been called');
    const captured = new URL(capturedUrl);
    assert.equal(captured.hostname, 'api.nal.usda.gov');
    assert.ok(capturedUrl.includes('/fdc/v1/foods/search'), 'should use the FDC search endpoint');
    assert.equal(capturedMethod, 'POST', 'should use POST to avoid URL-encoding issues with dataType');
    assert.ok(capturedBody, 'request body should be present');
    assert.equal(capturedBody.query, 'chicken', 'should pass the query in the request body');
    // The USDA FDC POST endpoint accepts dataType as a JSON array – unambiguous and
    // avoids the URL-encoding pitfalls that caused "food search unavailable" errors.
    const dataTypes = capturedBody.dataType;
    assert.ok(Array.isArray(dataTypes), 'dataType should be a JSON array');
    assert.ok(dataTypes.includes('Foundation'), 'should request Foundation data type');
    assert.ok(dataTypes.includes('SR Legacy'), 'should request SR Legacy data type');
    assert.ok(dataTypes.includes('Branded'), 'should request Branded data type');
    assert.ok(dataTypes.includes('Survey (FNDDS)'), 'should request Survey (FNDDS) data type');
  } finally {
    global.fetch = originalFetch;
  }
});

test('food search returns all foods that have a description, regardless of query words in name', async () => {
  app.foodSearchCache.clear();
  const originalFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (typeof url === 'string' && new URL(url).hostname === 'api.nal.usda.gov') {
      return {
        ok: true,
        json: async () => ({
          foods: [
            { description: 'Apple Juice', foodNutrients: [{ nutrientId: 1008, value: 46 }] },
            { description: 'Green Apple', foodNutrients: [{ nutrientId: 1008, value: 52 }] },
            { description: 'Marmite Yeast Extract', foodNutrients: [{ nutrientId: 1008, value: 260 }] },
            { description: 'Intense Dark 70% Cocoa', foodNutrients: [{ nutrientId: 1008, value: 550 }] },
            { description: '' },
          ],
        }),
      };
    }
    return originalFetch(url, opts);
  };
  try {
    const { status, body } = await req('GET', '/api/food/search?q=apple', undefined, aliceToken);
    assert.equal(status, 200);
    assert.equal(body.length, 4, 'all foods with a description should be returned, relying on FDC relevance ranking');
    assert.ok(body.every(r => r.name), 'every result must have a non-empty name');
  } finally {
    global.fetch = originalFetch;
  }
});

test('food search with multi-word query returns all named foods', async () => {
  app.foodSearchCache.clear();
  const originalFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (typeof url === 'string' && new URL(url).hostname === 'api.nal.usda.gov') {
      return {
        ok: true,
        json: async () => ({
          foods: [
            { description: 'Chicken Breast Fillets', foodNutrients: [{ nutrientId: 1008, value: 110 }] },
            { description: 'Roast Chicken', foodNutrients: [{ nutrientId: 1008, value: 153 }] },
            { description: 'Marmite Yeast Extract', foodNutrients: [{ nutrientId: 1008, value: 260 }] },
          ],
        }),
      };
    }
    return originalFetch(url, opts);
  };
  try {
    const { status, body } = await req('GET', '/api/food/search?q=chicken+breast', undefined, aliceToken);
    assert.equal(status, 200);
    assert.equal(body.length, 3, 'all named foods should be returned for multi-word queries');
    assert.ok(body.every(r => r.name), 'every result must have a non-empty name');
  } finally {
    global.fetch = originalFetch;
  }
});

test('food search returns 504 when upstream times out', async () => {
  app.foodSearchCache.clear();
  const originalFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (typeof url === 'string' && new URL(url).hostname === 'api.nal.usda.gov') {
      const err = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      throw err;
    }
    return originalFetch(url, opts);
  };
  try {
    const { status, body } = await req('GET', '/api/food/search?q=apple', undefined, aliceToken);
    assert.equal(status, 504);
    assert.ok(body.error, 'response should contain an error message');
    assert.ok(body.error.toLowerCase().includes('timed out'), 'error message should mention timeout');
  } finally {
    global.fetch = originalFetch;
  }
});

test('food search returns 502 when upstream returns a non-OK HTTP status', async () => {
  app.foodSearchCache.clear();
  const originalFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (typeof url === 'string' && new URL(url).hostname === 'api.nal.usda.gov') {
      return { ok: false, status: 503, json: async () => ({}) };
    }
    return originalFetch(url, opts);
  };
  try {
    const { status, body } = await req('GET', '/api/food/search?q=apple', undefined, aliceToken);
    assert.equal(status, 502);
    assert.ok(body.error, 'response should contain an error message');
  } finally {
    global.fetch = originalFetch;
  }
});

test('food search returns 502 when upstream returns invalid JSON', async () => {
  app.foodSearchCache.clear();
  const originalFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (typeof url === 'string' && new URL(url).hostname === 'api.nal.usda.gov') {
      return { ok: true, json: async () => { throw new SyntaxError('Unexpected token'); } };
    }
    return originalFetch(url, opts);
  };
  try {
    const { status, body } = await req('GET', '/api/food/search?q=apple', undefined, aliceToken);
    assert.equal(status, 502);
    assert.ok(body.error, 'response should contain an error message');
  } finally {
    global.fetch = originalFetch;
  }
});

test('food search returns 502 on network error with helpful message', async () => {
  app.foodSearchCache.clear();
  const originalFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (typeof url === 'string' && new URL(url).hostname === 'api.nal.usda.gov') {
      const err = new TypeError('fetch failed');
      err.code = 'ENOTFOUND';
      throw err;
    }
    return originalFetch(url, opts);
  };
  try {
    const { status, body } = await req('GET', '/api/food/search?q=apple', undefined, aliceToken);
    assert.equal(status, 502);
    assert.ok(body.error, 'response should contain an error message');
  } finally {
    global.fetch = originalFetch;
  }
});

test('food search caches successful results and avoids a second upstream call', async () => {
  app.foodSearchCache.clear();
  let callCount = 0;
  const originalFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (typeof url === 'string' && new URL(url).hostname === 'api.nal.usda.gov') {
      callCount++;
      return {
        ok: true,
        json: async () => ({
          foods: [
            { description: 'Banana', foodNutrients: [{ nutrientId: 1008, value: 89 }] },
          ],
        }),
      };
    }
    return originalFetch(url, opts);
  };
  try {
    const { status: s1, body: b1 } = await req('GET', '/api/food/search?q=banana', undefined, aliceToken);
    assert.equal(s1, 200);
    assert.equal(callCount, 1, 'upstream should be called on first request');

    const { status: s2, body: b2 } = await req('GET', '/api/food/search?q=banana', undefined, aliceToken);
    assert.equal(s2, 200);
    assert.equal(callCount, 1, 'upstream should NOT be called again; cached result should be served');
    assert.deepEqual(b2, b1, 'cached result should match the first response');
  } finally {
    global.fetch = originalFetch;
  }
});

test('reset user data deletes all fitness records', async () => {
  // Add some data
  await req('PUT', '/api/profile', { firstName: 'Alice' }, aliceToken);
  await req('POST', '/api/weights', { date: '2025-01-16', weight: '75.0', goal: '' }, aliceToken);
  await req('POST', '/api/calories', { date: '2025-01-16', meal: 'Dinner', food: 'Pizza', calories: '800' }, aliceToken);

  const { status } = await req('DELETE', '/api/user/data', undefined, aliceToken);
  assert.equal(status, 200);

  const { body: profile } = await req('GET', '/api/profile', undefined, aliceToken);
  assert.equal(profile, null);

  const { body: weights } = await req('GET', '/api/weights', undefined, aliceToken);
  assert.equal(weights.length, 0);

  const { body: calories } = await req('GET', '/api/calories', undefined, aliceToken);
  assert.equal(calories.length, 0);
});

// ── Data isolation between users ──────────────────────────────────────────────
test('users cannot see each other\'s data', async () => {
  // Register a second user and add data
  const { body: bobAuth } = await req('POST', '/api/auth/register', { username: 'bob', password: 'password123' });
  const bobToken = bobAuth.token;

  await req('POST', '/api/weights', { date: '2025-01-16', weight: '90.0', goal: '' }, bobToken);

  // Alice should still see 0 weight entries
  const { body: aliceWeights } = await req('GET', '/api/weights', undefined, aliceToken);
  assert.equal(aliceWeights.length, 0);

  // Bob should see 1
  const { body: bobWeights } = await req('GET', '/api/weights', undefined, bobToken);
  assert.equal(bobWeights.length, 1);
});

// ── Roles ─────────────────────────────────────────────────────────────────────
test('registered users get role "user" in JWT', async () => {
  const { body } = await req('POST', '/api/auth/register', { username: 'carol', password: 'password123' });
  assert.ok(body.token);
  const payload = JSON.parse(Buffer.from(body.token.split('.')[1], 'base64url').toString());
  assert.equal(payload.role, 'user');
});

test('login token includes role from database', async () => {
  const { body } = await req('POST', '/api/auth/login', { username: 'alice', password: 'password123' });
  const payload = JSON.parse(Buffer.from(body.token.split('.')[1], 'base64url').toString());
  assert.equal(payload.role, 'user');
});

// ── /api/user/me ──────────────────────────────────────────────────────────────
test('/api/user/me requires authentication', async () => {
  const { status } = await req('GET', '/api/user/me');
  assert.equal(status, 401);
});

test('/api/user/me returns current role from database, not JWT', async () => {
  // aliceToken was issued with role='user' (from 'setup: login alice').
  // Now promote alice to admin in the DB to simulate an admin changing her role
  // while she is already logged in with a stale token.
  db.prepare("UPDATE users SET role = 'admin' WHERE username = 'alice'").run();

  // The stale token still says role='user', but /api/user/me should return 'admin'
  const { status, body } = await req('GET', '/api/user/me', undefined, aliceToken);
  assert.equal(status, 200);
  assert.equal(body.role, 'admin');
  assert.equal(body.username, 'alice');
  assert.ok(body.userId);

  // Leave alice as admin for subsequent admin-route tests
});


// ── Admin routes ──────────────────────────────────────────────────────────────
let adminToken;
let carolId;
let trainerToken;
let trainerUserId;

test('setup: seed admin user directly in DB and login', async () => {
  // Promote alice to admin via DB so we have a bootstrap admin
  db.prepare("UPDATE users SET role = ? WHERE username = ?").run('admin', 'alice');
  const { body } = await req('POST', '/api/auth/login', { username: 'alice', password: 'password123' });
  adminToken = body.token;
  const payload = JSON.parse(Buffer.from(body.token.split('.')[1], 'base64url').toString());
  assert.equal(payload.role, 'admin');
});

test('non-admin cannot list users', async () => {
  const { body: carolAuth } = await req('POST', '/api/auth/login', { username: 'carol', password: 'password123' });
  const { status } = await req('GET', '/api/admin/users', undefined, carolAuth.token);
  assert.equal(status, 403);
});

test('admin with stale user JWT can still access admin endpoints', async () => {
  // aliceToken was issued with role='user' (see setup: login alice) but
  // alice's DB role is 'admin'. This simulates a user promoted to admin
  // while already logged in with an old token.
  const payload = JSON.parse(Buffer.from(aliceToken.split('.')[1], 'base64url').toString());
  assert.equal(payload.role, 'user');
  const { status, body } = await req('GET', '/api/admin/users', undefined, aliceToken);
  assert.equal(status, 200);
  assert.ok(Array.isArray(body));
});

test('admin can list all users', async () => {
  const { status, body } = await req('GET', '/api/admin/users', undefined, adminToken);
  assert.equal(status, 200);
  assert.ok(Array.isArray(body));
  assert.ok(body.length >= 3);
  body.forEach(u => {
    assert.ok(u.id);
    assert.ok(u.username);
    assert.ok(u.role);
  });
  carolId = body.find(u => u.username === 'carol').id;
});

test('admin can promote user to trainer', async () => {
  const { status, body } = await req('PUT', `/api/admin/users/${carolId}`, { role: 'trainer' }, adminToken);
  assert.equal(status, 200);
  assert.equal(body.ok, true);

  const { body: users } = await req('GET', '/api/admin/users', undefined, adminToken);
  const carol = users.find(u => u.id === carolId);
  assert.equal(carol.role, 'trainer');
});

test('admin update rejects invalid role', async () => {
  const { status, body } = await req('PUT', `/api/admin/users/${carolId}`, { role: 'superuser' }, adminToken);
  assert.equal(status, 400);
  assert.ok(body.error);
});

test('admin can update username', async () => {
  const { status, body } = await req('PUT', `/api/admin/users/${carolId}`, { username: 'carol_renamed' }, adminToken);
  assert.equal(status, 200);
  assert.equal(body.ok, true);

  const { body: users } = await req('GET', '/api/admin/users', undefined, adminToken);
  const carol = users.find(u => u.id === carolId);
  assert.equal(carol.username, 'carol_renamed');
  // Rename back for subsequent tests
  await req('PUT', `/api/admin/users/${carolId}`, { username: 'carol' }, adminToken);
});

test('admin update rejects duplicate username', async () => {
  const { status, body } = await req('PUT', `/api/admin/users/${carolId}`, { username: 'alice' }, adminToken);
  assert.equal(status, 409);
  assert.ok(body.error);
});

test('admin update rejects invalid username format', async () => {
  const { status, body } = await req('PUT', `/api/admin/users/${carolId}`, { username: 'bad username!' }, adminToken);
  assert.equal(status, 400);
  assert.ok(body.error);
});

test('admin can reset user password', async () => {
  const { status, body } = await req('PUT', `/api/admin/users/${carolId}`, { password: 'newpassword123' }, adminToken);
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  // Reset password back for subsequent tests
  await req('PUT', `/api/admin/users/${carolId}`, { password: 'password123' }, adminToken);
});

test('admin update returns 404 for non-existent user', async () => {
  const { status, body } = await req('PUT', '/api/admin/users/99999', { username: 'nobody' }, adminToken);
  assert.equal(status, 404);
  assert.ok(body.error);
});

test('admin cannot delete their own account', async () => {
  const { body: users } = await req('GET', '/api/admin/users', undefined, adminToken);
  const aliceId = users.find(u => u.username === 'alice').id;
  const { status } = await req('DELETE', `/api/admin/users/${aliceId}`, undefined, adminToken);
  assert.equal(status, 400);
});

test('admin can assign trainer to user', async () => {
  const { body: users } = await req('GET', '/api/admin/users', undefined, adminToken);
  const bobUser = users.find(u => u.username === 'bob');

  const { status, body } = await req('POST', '/api/admin/assignments', { trainerId: carolId, userId: bobUser.id }, adminToken);
  assert.equal(status, 201);
  assert.equal(body.ok, true);
});

test('assigning a non-trainer returns 400', async () => {
  const { body: users } = await req('GET', '/api/admin/users', undefined, adminToken);
  const bobUser = users.find(u => u.username === 'bob');
  // Try assigning bob (a 'user') as a trainer
  const { status, body } = await req('POST', '/api/admin/assignments', { trainerId: bobUser.id, userId: carolId }, adminToken);
  assert.equal(status, 400);
  assert.ok(body.error);
});

test('admin can list assignments for a trainer', async () => {
  const { status, body } = await req('GET', `/api/admin/assignments/${carolId}`, undefined, adminToken);
  assert.equal(status, 200);
  assert.ok(Array.isArray(body));
  assert.equal(body.length, 1);
  assert.equal(body[0].username, 'bob');
});

test('admin assignments endpoint returns 400 for non-trainer user', async () => {
  const { body: users } = await req('GET', '/api/admin/users', undefined, adminToken);
  const bobUser = users.find(u => u.username === 'bob');
  const { status, body } = await req('GET', `/api/admin/assignments/${bobUser.id}`, undefined, adminToken);
  assert.equal(status, 400);
  assert.ok(body.error);
});

// ── Trainer routes ────────────────────────────────────────────────────────────
test('setup: login carol as trainer', async () => {
  const { body } = await req('POST', '/api/auth/login', { username: 'carol', password: 'password123' });
  trainerToken = body.token;
  const payload = JSON.parse(Buffer.from(body.token.split('.')[1], 'base64url').toString());
  assert.equal(payload.role, 'trainer');
});

test('trainer with stale user JWT can still access trainer endpoints', async () => {
  // carol is a trainer in the DB. Craft a JWT that claims role='user' to
  // simulate carol's token being issued before she was promoted to trainer.
  // This avoids calling /api/auth/register (which would hit the rate limiter).
  const carolUser = db.prepare('SELECT id FROM users WHERE username = ?').get('carol');
  const staleToken = jwt.sign(
    { userId: carolUser.id, username: 'carol', role: 'user' },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
  const payload = JSON.parse(Buffer.from(staleToken.split('.')[1], 'base64url').toString());
  assert.equal(payload.role, 'user');
  const { status, body } = await req('GET', '/api/trainer/users', undefined, staleToken);
  assert.equal(status, 200);
  assert.ok(Array.isArray(body));
});

test('non-admin cannot list trainer assignments', async () => {
  const { status } = await req('GET', `/api/admin/assignments/${carolId}`, undefined, trainerToken);
  assert.equal(status, 403);
});

test('trainer can list their assigned users', async () => {
  const { status, body } = await req('GET', '/api/trainer/users', undefined, trainerToken);
  assert.equal(status, 200);
  assert.ok(Array.isArray(body));
  assert.equal(body.length, 1);
  assert.equal(body[0].username, 'bob');
});

test('trainer can view assigned user weights', async () => {
  const { body: users } = await req('GET', '/api/trainer/users', undefined, trainerToken);
  const bobId = users[0].id;
  const { status, body } = await req('GET', `/api/trainer/users/${bobId}/weights`, undefined, trainerToken);
  assert.equal(status, 200);
  assert.ok(Array.isArray(body));
});

test('trainer can view assigned user 1RM entries', async () => {
  const { body: users } = await req('GET', '/api/trainer/users', undefined, trainerToken);
  const bobId = users[0].id;
  const { status, body } = await req('GET', `/api/trainer/users/${bobId}/1rm`, undefined, trainerToken);
  assert.equal(status, 200);
  assert.ok(Array.isArray(body));
});

test('trainer cannot view 1RM for unassigned user', async () => {
  const { body: allUsers } = await req('GET', '/api/admin/users', undefined, adminToken);
  const aliceId = allUsers.find(u => u.username === 'alice').id;
  const { status } = await req('GET', `/api/trainer/users/${aliceId}/1rm`, undefined, trainerToken);
  assert.equal(status, 403);
});

test('trainer cannot view unassigned user data', async () => {
  // alice is not assigned to carol
  const { body: allUsers } = await req('GET', '/api/admin/users', undefined, adminToken);
  const aliceId = allUsers.find(u => u.username === 'alice').id;
  const { status } = await req('GET', `/api/trainer/users/${aliceId}/weights`, undefined, trainerToken);
  assert.equal(status, 403);
});

test('regular user cannot access trainer routes', async () => {
  const { body: bobAuth } = await req('POST', '/api/auth/login', { username: 'bob', password: 'password123' });
  const { status } = await req('GET', '/api/trainer/users', undefined, bobAuth.token);
  assert.equal(status, 403);
});

test('admin can remove trainer assignment', async () => {
  const { body: users } = await req('GET', '/api/admin/users', undefined, adminToken);
  const bobUser = users.find(u => u.username === 'bob');
  const { status, body } = await req('DELETE', `/api/admin/assignments/${carolId}/${bobUser.id}`, undefined, adminToken);
  assert.equal(status, 200);
  assert.equal(body.ok, true);

  // Carol should now see empty list
  const { body: assigned } = await req('GET', '/api/trainer/users', undefined, trainerToken);
  assert.equal(assigned.length, 0);
});

test('admin can delete a user', async () => {
  // Register a throwaway user, then admin deletes them
  const { body: tmpAuth } = await req('POST', '/api/auth/register', { username: 'tmp_user', password: 'password123' });
  const { body: users } = await req('GET', '/api/admin/users', undefined, adminToken);
  const tmpId = users.find(u => u.username === 'tmp_user').id;

  const { status, body } = await req('DELETE', `/api/admin/users/${tmpId}`, undefined, adminToken);
  assert.equal(status, 200);
  assert.equal(body.ok, true);

  const { body: afterUsers } = await req('GET', '/api/admin/users', undefined, adminToken);
  assert.ok(!afterUsers.find(u => u.username === 'tmp_user'));
});

// ── Admin create user ─────────────────────────────────────────────────────────
test('admin can create a new user', async () => {
  const { status, body } = await req('POST', '/api/admin/users', { username: 'newuser', password: 'password123', role: 'user' }, adminToken);
  assert.equal(status, 201);
  assert.ok(body.ok);
  assert.ok(body.id);

  const { body: users } = await req('GET', '/api/admin/users', undefined, adminToken);
  assert.ok(users.find(u => u.username === 'newuser'));
});

test('admin can create a trainer via admin endpoint', async () => {
  const { status, body } = await req('POST', '/api/admin/users', { username: 'newtrainer', password: 'password123', role: 'trainer' }, adminToken);
  assert.equal(status, 201);
  assert.ok(body.ok);

  const { body: users } = await req('GET', '/api/admin/users', undefined, adminToken);
  const created = users.find(u => u.username === 'newtrainer');
  assert.ok(created);
  assert.equal(created.role, 'trainer');
});

test('admin create user rejects duplicate username', async () => {
  const { status, body } = await req('POST', '/api/admin/users', { username: 'alice', password: 'password123' }, adminToken);
  assert.equal(status, 409);
  assert.ok(body.error);
});

test('admin create user rejects short password', async () => {
  const { status, body } = await req('POST', '/api/admin/users', { username: 'brandnew_short', password: 'short' }, adminToken);
  assert.equal(status, 400);
  assert.ok(body.error);
});

test('admin create user rejects invalid role', async () => {
  const { status, body } = await req('POST', '/api/admin/users', { username: 'brandnew_role', password: 'password123', role: 'superuser' }, adminToken);
  assert.equal(status, 400);
  assert.ok(body.error);
});

test('non-admin cannot create users via admin endpoint', async () => {
  const { body: carolAuth } = await req('POST', '/api/auth/login', { username: 'carol', password: 'password123' });
  const { status } = await req('POST', '/api/admin/users', { username: 'brandnew_nonadmin', password: 'password123' }, carolAuth.token);
  assert.equal(status, 403);
});

// ── Trainer Plans ─────────────────────────────────────────────────────────────
let planId;

test('trainer can create a plan', async () => {
  const plan = {
    name: 'Beginner Strength',
    description: '3-day beginner program',
    exercises: [
      { name: 'Squat', sets: '3', reps: '5', weightKg: '60', notes: 'Keep chest up' },
      { name: 'Bench Press', sets: '3', reps: '5', weightKg: '50', notes: '' },
    ],
  };
  const { status, body } = await req('POST', '/api/trainer/plans', plan, trainerToken);
  assert.equal(status, 201);
  assert.ok(body.id);
  planId = body.id;
});

test('trainer can list their plans', async () => {
  const { status, body } = await req('GET', '/api/trainer/plans', undefined, trainerToken);
  assert.equal(status, 200);
  assert.ok(Array.isArray(body));
  assert.equal(body.length, 1);
  assert.equal(body[0].name, 'Beginner Strength');
  assert.equal(body[0].exercises.length, 2);
});

test('trainer can update a plan', async () => {
  const { status, body } = await req('PUT', `/api/trainer/plans/${planId}`, {
    name: 'Beginner Strength v2',
    description: 'Updated',
    exercises: [{ name: 'Deadlift', sets: '3', reps: '5', weightKg: '80', notes: '' }],
  }, trainerToken);
  assert.equal(status, 200);
  assert.equal(body.ok, true);

  const { body: plans } = await req('GET', '/api/trainer/plans', undefined, trainerToken);
  assert.equal(plans[0].name, 'Beginner Strength v2');
  assert.equal(plans[0].exercises[0].name, 'Deadlift');
});

test('plan creation requires name and exercises', async () => {
  const { status, body } = await req('POST', '/api/trainer/plans', { name: 'Bad plan' }, trainerToken);
  assert.equal(status, 400);
  assert.ok(body.error);
});

test('regular user cannot create plans', async () => {
  const { body: bobAuth } = await req('POST', '/api/auth/login', { username: 'bob', password: 'password123' });
  const { status } = await req('POST', '/api/trainer/plans', {
    name: 'My Plan', exercises: [{ name: 'Run' }],
  }, bobAuth.token);
  assert.equal(status, 403);
});

test('trainer can assign a plan to an assigned athlete', async () => {
  // Re-assign carol->bob for this test
  const { body: users } = await req('GET', '/api/admin/users', undefined, adminToken);
  const bobUser = users.find(u => u.username === 'bob');
  await req('POST', '/api/admin/assignments', { trainerId: carolId, userId: bobUser.id }, adminToken);

  const { status, body } = await req('POST', `/api/trainer/plans/${planId}/assign`, { userId: bobUser.id }, trainerToken);
  assert.equal(status, 201);
  assert.equal(body.ok, true);
});

test('trainer can list plan assignments', async () => {
  const { status, body } = await req('GET', `/api/trainer/plans/${planId}/assignments`, undefined, trainerToken);
  assert.equal(status, 200);
  assert.ok(Array.isArray(body));
  assert.equal(body.length, 1);
  assert.equal(body[0].username, 'bob');
});

test('assigned user can view their plans', async () => {
  const { body: bobAuth } = await req('POST', '/api/auth/login', { username: 'bob', password: 'password123' });
  const { status, body } = await req('GET', '/api/user/plans', undefined, bobAuth.token);
  assert.equal(status, 200);
  assert.ok(Array.isArray(body));
  assert.equal(body.length, 1);
  assert.equal(body[0].name, 'Beginner Strength v2');
});

test('trainer can remove a plan assignment', async () => {
  const { body: users } = await req('GET', '/api/admin/users', undefined, adminToken);
  const bobUser = users.find(u => u.username === 'bob');
  const { status, body } = await req('DELETE', `/api/trainer/plans/${planId}/assign/${bobUser.id}`, undefined, trainerToken);
  assert.equal(status, 200);
  assert.equal(body.ok, true);

  const { body: assignments } = await req('GET', `/api/trainer/plans/${planId}/assignments`, undefined, trainerToken);
  assert.equal(assignments.length, 0);
});

test('trainer cannot assign plan to unassigned user', async () => {
  // alice is not assigned to carol
  const { body: users } = await req('GET', '/api/admin/users', undefined, adminToken);
  const aliceId = users.find(u => u.username === 'alice').id;
  const { status, body } = await req('POST', `/api/trainer/plans/${planId}/assign`, { userId: aliceId }, trainerToken);
  assert.equal(status, 403);
  assert.ok(body.error);
});

test('trainer can delete a plan', async () => {
  const { status, body } = await req('DELETE', `/api/trainer/plans/${planId}`, undefined, trainerToken);
  assert.equal(status, 200);
  assert.equal(body.ok, true);

  const { body: plans } = await req('GET', '/api/trainer/plans', undefined, trainerToken);
  assert.equal(plans.length, 0);
});

// ── Schedule ───────────────────────────────────────────────────────────────────
let scheduleId;

test('user can schedule a workout', async () => {
  const { status, body } = await req('POST', '/api/schedule', {
    date: '2025-06-15',
    title: 'Morning Run',
    notes: 'Easy pace',
  }, aliceToken);
  assert.equal(status, 201);
  assert.ok(body.id);
  scheduleId = body.id;
});

test('schedule creation requires date and title', async () => {
  const { status, body } = await req('POST', '/api/schedule', { notes: 'Missing fields' }, aliceToken);
  assert.equal(status, 400);
  assert.ok(body.error);
});

test('schedule creation rejects invalid date format', async () => {
  const { status, body } = await req('POST', '/api/schedule', { date: '15-06-2025', title: 'Bad date' }, aliceToken);
  assert.equal(status, 400);
  assert.ok(body.error);
});

test('user can list their schedule', async () => {
  const { status, body } = await req('GET', '/api/schedule', undefined, aliceToken);
  assert.equal(status, 200);
  assert.ok(Array.isArray(body));
  assert.ok(body.length >= 1);
  const entry = body.find(e => e.id === scheduleId);
  assert.ok(entry, 'scheduled entry should appear in list');
  assert.equal(entry.title, 'Morning Run');
  assert.equal(entry.date, '2025-06-15');
});

test('user can filter schedule by date range', async () => {
  const { status, body } = await req('GET', '/api/schedule?from=2025-06-01&to=2025-06-30', undefined, aliceToken);
  assert.equal(status, 200);
  assert.ok(Array.isArray(body));
  assert.ok(body.some(e => e.id === scheduleId));
});

test('user can update a scheduled workout', async () => {
  const { status, body } = await req('PUT', `/api/schedule/${scheduleId}`, {
    date: '2025-06-16',
    title: 'Evening Run',
    notes: 'Faster pace',
  }, aliceToken);
  assert.equal(status, 200);
  assert.equal(body.ok, true);

  const { body: list } = await req('GET', '/api/schedule', undefined, aliceToken);
  const entry = list.find(e => e.id === scheduleId);
  assert.equal(entry.title, 'Evening Run');
  assert.equal(entry.date, '2025-06-16');
});

test('user cannot update another user schedule entry', async () => {
  // Create a user directly in the DB to avoid hitting the auth rate limiter
  const otherInfo = db.prepare("INSERT INTO users (username, password_hash) VALUES (?, '!')").run('sched_other_user');
  const otherToken = jwt.sign(
    { userId: otherInfo.lastInsertRowid, username: 'sched_other_user', role: 'user' },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
  const { status } = await req('PUT', `/api/schedule/${scheduleId}`, {
    date: '2025-06-16', title: 'Hacked',
  }, otherToken);
  assert.equal(status, 403);
});

test('schedule requires auth', async () => {
  const { status } = await req('GET', '/api/schedule');
  assert.equal(status, 401);
});

test('trainer can schedule a workout for an assigned athlete', async () => {
  // Create a fresh athlete directly in the DB to avoid the auth rate limiter
  const athleteInfo = db.prepare("INSERT INTO users (username, password_hash) VALUES (?, '!')").run('sched_athlete');
  const athleteId    = athleteInfo.lastInsertRowid;
  const athleteToken = jwt.sign(
    { userId: athleteId, username: 'sched_athlete', role: 'user' },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
  // Assign the fresh athlete to carol
  await req('POST', '/api/admin/assignments', { trainerId: carolId, userId: athleteId }, adminToken);

  const { status, body } = await req('POST', '/api/trainer/schedule', {
    userId: athleteId,
    date: '2025-07-01',
    title: 'Trainer-assigned session',
    notes: 'Focus on form',
  }, trainerToken);
  assert.equal(status, 201);
  assert.ok(body.id);

  // Athlete can see it in their schedule
  const { status: sStatus, body: schedule } = await req('GET', '/api/schedule', undefined, athleteToken);
  assert.equal(sStatus, 200);
  assert.ok(Array.isArray(schedule), 'schedule should be an array');
  assert.ok(schedule.some(e => e.title === 'Trainer-assigned session'));
});

test('trainer cannot schedule for unassigned user', async () => {
  // alice is not assigned to carol
  const { body: users } = await req('GET', '/api/admin/users', undefined, adminToken);
  const aliceId = users.find(u => u.username === 'alice').id;
  const { status, body } = await req('POST', '/api/trainer/schedule', {
    userId: aliceId,
    date: '2025-07-02',
    title: 'Unassigned',
  }, trainerToken);
  assert.equal(status, 403);
  assert.ok(body.error);
});

test('user can delete a scheduled workout', async () => {
  const { status, body } = await req('DELETE', `/api/schedule/${scheduleId}`, undefined, aliceToken);
  assert.equal(status, 200);
  assert.equal(body.ok, true);

  const { body: list } = await req('GET', '/api/schedule', undefined, aliceToken);
  assert.ok(!list.some(e => e.id === scheduleId));
});

test('trainer can view assigned athlete schedule via ?userId', async () => {
  // Create a fresh athlete and assign to carol
  const athleteInfo = db.prepare("INSERT INTO users (username, password_hash) VALUES (?, '!')").run('sched_athlete2');
  const athleteId    = athleteInfo.lastInsertRowid;
  const athleteToken = jwt.sign(
    { userId: athleteId, username: 'sched_athlete2', role: 'user' },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
  await req('POST', '/api/admin/assignments', { trainerId: carolId, userId: athleteId }, adminToken);

  // Trainer schedules a workout for the athlete
  await req('POST', '/api/trainer/schedule', {
    userId: athleteId,
    date: '2025-08-01',
    title: 'Trainer view test',
  }, trainerToken);

  // Trainer views athlete schedule via ?userId
  const { status, body } = await req('GET', `/api/schedule?userId=${athleteId}`, undefined, trainerToken);
  assert.equal(status, 200);
  assert.ok(Array.isArray(body));
  assert.ok(body.some(e => e.title === 'Trainer view test'));

  // Athlete can also see it
  const { body: athleteSchedule } = await req('GET', '/api/schedule', undefined, athleteToken);
  assert.ok(athleteSchedule.some(e => e.title === 'Trainer view test'));
});

test('trainer cannot view schedule for unassigned athlete via ?userId', async () => {
  const { body: users } = await req('GET', '/api/admin/users', undefined, adminToken);
  const aliceId = users.find(u => u.username === 'alice').id;
  const { status, body } = await req('GET', `/api/schedule?userId=${aliceId}`, undefined, trainerToken);
  assert.equal(status, 403);
  assert.ok(body.error);
});

test('regular user cannot view another user schedule via ?userId', async () => {
  const { body: users } = await req('GET', '/api/admin/users', undefined, adminToken);
  const bobId = users.find(u => u.username === 'bob').id;
  // Use a freshly created regular user (alice is admin by this point in the test sequence)
  const regularUserInfo = db.prepare("INSERT INTO users (username, password_hash) VALUES (?, '!')").run('regular_user');
  const regularToken = jwt.sign(
    { userId: regularUserInfo.lastInsertRowid, username: 'regular_user', role: 'user' },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
  const { status, body } = await req('GET', `/api/schedule?userId=${bobId}`, undefined, regularToken);
  assert.equal(status, 403);
  assert.ok(body.error);
});

test('trainer can view assigned athlete plans via ?userId', async () => {
  // Create fresh trainer-athlete setup
  const athlInfo = db.prepare("INSERT INTO users (username, password_hash) VALUES (?, '!')").run('plan_athlete');
  const athlId   = athlInfo.lastInsertRowid;
  const athlToken = jwt.sign(
    { userId: athlId, username: 'plan_athlete', role: 'user' },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
  await req('POST', '/api/admin/assignments', { trainerId: carolId, userId: athlId }, adminToken);

  // Trainer creates and assigns a plan to the athlete
  const { body: planBody } = await req('POST', '/api/trainer/plans', {
    name: 'Athlete Plan',
    exercises: [{ name: 'Squat', sets: '3', reps: '10', weightKg: '60', notes: '' }],
  }, trainerToken);
  await req('POST', `/api/trainer/plans/${planBody.id}/assign`, { userId: athlId }, trainerToken);

  // Trainer views athlete's plans via ?userId
  const { status, body } = await req('GET', `/api/user/plans?userId=${athlId}`, undefined, trainerToken);
  assert.equal(status, 200);
  assert.ok(Array.isArray(body));
  assert.equal(body.length, 1);
  assert.equal(body[0].name, 'Athlete Plan');

  // Athlete can also see it
  const { body: athlPlans } = await req('GET', '/api/user/plans', undefined, athlToken);
  assert.equal(athlPlans.length, 1);
  assert.equal(athlPlans[0].name, 'Athlete Plan');
});

test('trainer cannot view plans for unassigned athlete via ?userId', async () => {
  const { body: users } = await req('GET', '/api/admin/users', undefined, adminToken);
  const aliceId = users.find(u => u.username === 'alice').id;
  const { status, body } = await req('GET', `/api/user/plans?userId=${aliceId}`, undefined, trainerToken);
  assert.equal(status, 403);
  assert.ok(body.error);
});

// ── Schedule complete ─────────────────────────────────────────────────────────
let scheduleCompleteId;

test('setup: create a scheduled workout to complete', async () => {
  const { body } = await req('POST', '/api/schedule', { date: '2025-06-01', title: 'Leg Day', notes: 'Heavy squats' }, aliceToken);
  assert.equal(body.ok, true);
  scheduleCompleteId = body.id;
  assert.ok(scheduleCompleteId);
});

test('completing a scheduled workout creates a workout entry', async () => {
  const { status, body } = await req('POST', `/api/schedule/${scheduleCompleteId}/complete`, {}, aliceToken);
  assert.equal(status, 201);
  assert.equal(body.ok, true);
  assert.ok(body.workoutId, 'should return the new workout id');

  const { body: workouts } = await req('GET', '/api/workouts', undefined, aliceToken);
  const created = workouts.find(w => w.id === body.workoutId);
  assert.ok(created, 'workout should appear in the workout list');
  assert.equal(created.date, '2025-06-01');
  assert.ok(created.notes.includes('Leg Day'), 'notes should include the scheduled workout title');
  assert.ok(Array.isArray(created.exercises), 'exercises should be an array');
});

test('completing a scheduled workout with a plan copies plan exercises into the workout', async () => {
  // Create a fresh athlete assigned to carol (the trainer) to avoid rate limiting
  const planAthleteInfo = db.prepare("INSERT INTO users (username, password_hash) VALUES (?, '!')").run('plan_complete_athlete');
  const planAthleteId    = planAthleteInfo.lastInsertRowid;
  const planAthleteToken = jwt.sign(
    { userId: planAthleteId, username: 'plan_complete_athlete', role: 'user' },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
  await req('POST', '/api/admin/assignments', { trainerId: carolId, userId: planAthleteId }, adminToken);

  // Create a plan with exercises
  const { body: planBody } = await req('POST', '/api/trainer/plans', {
    name: 'Plan With Exercises',
    description: 'Test plan',
    exercises: [
      { name: 'Squat', sets: '3', reps: '5', weightKg: '60', notes: '' },
      { name: 'Deadlift', sets: '3', reps: '3', weightKg: '80', notes: '' },
    ],
  }, trainerToken);
  assert.ok(planBody.id, 'plan should be created');

  // Trainer schedules a workout for the athlete linked to that plan
  const { body: schedBody } = await req('POST', '/api/trainer/schedule', {
    userId: planAthleteId,
    date: '2025-07-10',
    title: 'Plan Day',
    planId: planBody.id,
  }, trainerToken);
  assert.ok(schedBody.id, 'scheduled workout should be created');

  // Athlete completes the scheduled workout
  const { status, body } = await req('POST', `/api/schedule/${schedBody.id}/complete`, {}, planAthleteToken);
  assert.equal(status, 201);
  assert.ok(body.workoutId);

  // The created workout should include exercises from the plan
  const { body: workouts } = await req('GET', '/api/workouts', undefined, planAthleteToken);
  const created = workouts.find(w => w.id === body.workoutId);
  assert.ok(created, 'workout should appear in the workout list');
  assert.ok(Array.isArray(created.exercises), 'exercises should be an array');
  assert.equal(created.exercises.length, 2, 'exercises should be copied from the plan');
  assert.equal(created.exercises[0].name, 'Squat');
  assert.equal(created.exercises[1].name, 'Deadlift');
});

test('completing a non-existent scheduled workout returns 404', async () => {
  const { status, body } = await req('POST', '/api/schedule/does-not-exist/complete', {}, aliceToken);
  assert.equal(status, 404);
  assert.ok(body.error);
});

test("completing another user's scheduled workout returns 403", async () => {
  // Create a different user via DB insert to avoid hitting the auth rate limiter
  const otherUserInfo = db.prepare("INSERT INTO users (username, password_hash) VALUES (?, '!')").run('other_user_complete');
  const otherToken = jwt.sign(
    { userId: otherUserInfo.lastInsertRowid, username: 'other_user_complete', role: 'user' },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );

  // Other user tries to complete Alice's scheduled workout
  const { status, body } = await req('POST', `/api/schedule/${scheduleCompleteId}/complete`, {}, otherToken);
  assert.equal(status, 403);
  assert.ok(body.error);
});

test('completing a scheduled workout requires auth', async () => {
  const { status } = await req('POST', `/api/schedule/${scheduleCompleteId}/complete`, {});
  assert.equal(status, 401);
});

// ── Workout Generator ─────────────────────────────────────────────────────────

test('workout generator requires auth', async () => {
  const { status } = await req('POST', '/api/workout-generator', { intensity: 5, muscleGroups: ['chest'] });
  assert.equal(status, 401);
});

test('workout generator returns 400 when intensity is missing', async () => {
  const { status, body } = await req('POST', '/api/workout-generator', { muscleGroups: ['chest'] }, aliceToken);
  assert.equal(status, 400);
  assert.ok(body.error);
});

test('workout generator returns 400 when intensity is out of range', async () => {
  const { status, body } = await req('POST', '/api/workout-generator', { intensity: 11, muscleGroups: ['chest'] }, aliceToken);
  assert.equal(status, 400);
  assert.ok(body.error);
});

test('workout generator returns 400 when muscleGroups is empty', async () => {
  const { status, body } = await req('POST', '/api/workout-generator', { intensity: 5, muscleGroups: [] }, aliceToken);
  assert.equal(status, 400);
  assert.ok(body.error);
});

test('workout generator returns 400 for invalid muscle group', async () => {
  const { status, body } = await req('POST', '/api/workout-generator', { intensity: 5, muscleGroups: ['invalid'] }, aliceToken);
  assert.equal(status, 400);
  assert.ok(body.error);
});

test('workout generator returns 400 for negative avoidDays', async () => {
  const { status, body } = await req('POST', '/api/workout-generator', { intensity: 5, muscleGroups: ['chest'], avoidDays: -1 }, aliceToken);
  assert.equal(status, 400);
  assert.ok(body.error);
});

test('workout generator returns exercises for a single muscle group', async () => {
  const { status, body } = await req('POST', '/api/workout-generator', { intensity: 5, muscleGroups: ['chest'], avoidDays: 0 }, aliceToken);
  assert.equal(status, 200);
  assert.ok(Array.isArray(body.exercises), 'exercises should be an array');
  assert.ok(body.exercises.length > 0, 'should return at least one exercise');
  body.exercises.forEach(ex => {
    assert.equal(ex.muscleGroup, 'chest');
    assert.ok(ex.name, 'exercise should have a name');
    assert.ok(Number.isFinite(ex.sets) && ex.sets > 0, 'sets should be a positive number');
    assert.ok(Number.isFinite(ex.reps) && ex.reps > 0, 'reps should be a positive number');
    assert.equal(ex.intensityPct, body.intensityPct);
  });
});

test('workout generator returns exercises for multiple muscle groups', async () => {
  const { status, body } = await req('POST', '/api/workout-generator', {
    intensity: 7,
    muscleGroups: ['chest', 'back', 'legs'],
    avoidDays: 0,
  }, aliceToken);
  assert.equal(status, 200);
  assert.ok(body.exercises.length > 0);
  const groups = new Set(body.exercises.map(ex => ex.muscleGroup));
  assert.ok(groups.has('chest'));
  assert.ok(groups.has('back'));
  assert.ok(groups.has('legs'));
});

test('workout generator intensity 1 gives 50% intensity percentage', async () => {
  const { status, body } = await req('POST', '/api/workout-generator', { intensity: 1, muscleGroups: ['chest'] }, aliceToken);
  assert.equal(status, 200);
  assert.equal(body.intensity, 1);
  assert.equal(body.intensityPct, 50);
});

test('workout generator intensity 10 gives 100% intensity percentage', async () => {
  const { status, body } = await req('POST', '/api/workout-generator', { intensity: 10, muscleGroups: ['chest'] }, aliceToken);
  assert.equal(status, 200);
  assert.equal(body.intensity, 10);
  assert.equal(body.intensityPct, 100);
});

test('workout generator calculates suggested weight from 1RM', async () => {
  // Set a 1RM for an exercise in the chest pool
  await req('PUT', '/api/1rm/Bench%20press%20(barbell)', { weightKg: 100 }, aliceToken);

  const { status, body } = await req('POST', '/api/workout-generator', {
    intensity: 10,
    muscleGroups: ['chest'],
    avoidDays: 0,
  }, aliceToken);
  assert.equal(status, 200);

  const benchEx = body.exercises.find(ex => ex.name === 'Bench press (barbell)');
  if (benchEx) {
    assert.equal(benchEx.oneRepMaxKg, 100);
    assert.ok(benchEx.suggestedWeightKg !== null, 'suggestedWeightKg should be set when 1RM exists');
    assert.ok(benchEx.suggestedWeightKg > 0, 'suggested weight should be positive');
    // At intensity 10 (100%), suggested weight should equal 1RM rounded to nearest 2.5 kg
    assert.equal(benchEx.suggestedWeightKg, 100);
  }
});

test('workout generator rounds suggested weight to nearest 2.5 kg', async () => {
  // 83% of 100 kg = 83 kg → nearest 2.5 kg = 82.5 kg
  await req('PUT', '/api/1rm/Bench%20press%20(barbell)', { weightKg: 100 }, aliceToken);
  const { status, body } = await req('POST', '/api/workout-generator', {
    intensity: 7, // intensityPct = round(50 + 6/9*50) = 83%
    muscleGroups: ['chest'],
    avoidDays: 0,
  }, aliceToken);
  assert.equal(status, 200);
  assert.equal(body.intensityPct, 83);
  const benchEx = body.exercises.find(ex => ex.name === 'Bench press (barbell)');
  if (benchEx) {
    assert.equal(benchEx.suggestedWeightKg, 82.5, '83% of 100 kg should round to 82.5 kg (nearest 2.5)');
  }
});

test('workout generator excludes recently done exercises when avoidDays > 0', async () => {
  // Create a user in the DB to test avoidance in isolation
  const genUserInfo = db.prepare("INSERT INTO users (username, password_hash) VALUES (?, '!')").run('gen_avoid_user');
  const genUserId = genUserInfo.lastInsertRowid;
  const genToken = jwt.sign(
    { userId: genUserId, username: 'gen_avoid_user', role: 'user' },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );

  // Log a recent workout containing all chest exercises
  const chestExercises = [
    'Bench press (barbell)',
    'Incline bench press (barbell)',
    'Dumbbell bench press',
    'Incline dumbbell press',
    'Chest press (machine)',
  ];
  await req('POST', '/api/workouts', {
    date: new Date().toISOString().split('T')[0],
    notes: 'Chest day',
    exercises: chestExercises.map(name => ({ name, sets: '3', reps: '10', weightKg: '60' })),
  }, genToken);

  // Generator with avoidDays=3 should produce no chest exercises
  const { status, body } = await req('POST', '/api/workout-generator', {
    intensity: 5,
    muscleGroups: ['chest'],
    avoidDays: 3,
  }, genToken);
  assert.equal(status, 200);
  assert.equal(body.exercises.length, 0, 'all chest exercises were done recently, so none should be returned');
  assert.ok(body.avoidedCount > 0, 'avoidedCount should reflect excluded exercises');
});

test('workout generator with avoidDays=0 does not exclude any exercises', async () => {
  const { status, body } = await req('POST', '/api/workout-generator', {
    intensity: 5,
    muscleGroups: ['biceps'],
    avoidDays: 0,
  }, aliceToken);
  assert.equal(status, 200);
  assert.ok(body.exercises.length > 0);
  assert.equal(body.avoidedCount, 0);
});

test('workout generator supports all valid muscle groups', async () => {
  const validGroups = ['chest', 'shoulders', 'triceps', 'back', 'biceps', 'core', 'legs', 'fullbody'];
  const { status, body } = await req('POST', '/api/workout-generator', {
    intensity: 5,
    muscleGroups: validGroups,
    avoidDays: 0,
  }, aliceToken);
  assert.equal(status, 200);
  assert.ok(body.exercises.length > 0);
  const returnedGroups = new Set(body.exercises.map(ex => ex.muscleGroup));
  validGroups.forEach(g => assert.ok(returnedGroups.has(g), `should have exercises for group: ${g}`));
});

test('workout generator includes exercises even when no 1RM is set', async () => {
  const { status, body } = await req('POST', '/api/workout-generator', {
    intensity: 5,
    muscleGroups: ['chest'],
    avoidDays: 0,
  }, aliceToken);
  assert.equal(status, 200);
  assert.ok(body.exercises.length > 0, 'exercises should be returned even without any 1RM set');
  const noOneRmExercises = body.exercises.filter(ex => ex.suggestedWeightKg === null);
  assert.ok(noOneRmExercises.length > 0, 'exercises without 1RM should have suggestedWeightKg: null');
});

test('save plan requires auth', async () => {
  const { status } = await req('POST', '/api/user/saved-plans', {
    name: 'My Plan',
    exercises: [{ name: 'Bench press (barbell)', sets: '3', reps: '10', weightKg: '', notes: '' }],
  });
  assert.equal(status, 401);
});

test('save plan returns 400 when name is missing', async () => {
  const { status, body } = await req('POST', '/api/user/saved-plans', {
    exercises: [{ name: 'Bench press (barbell)', sets: '3', reps: '10', weightKg: '', notes: '' }],
  }, aliceToken);
  assert.equal(status, 400);
  assert.ok(body.error);
});

test('save plan returns 400 when exercises array is empty', async () => {
  const { status, body } = await req('POST', '/api/user/saved-plans', {
    name: 'My Plan',
    exercises: [],
  }, aliceToken);
  assert.equal(status, 400);
  assert.ok(body.error);
});

test('save plan creates a plan and assigns it to the user', async () => {
  const exercises = [
    { name: 'Bench press (barbell)', sets: '4', reps: '8', weightKg: '80', notes: '' },
    { name: 'Incline dumbbell press', sets: '3', reps: '12', weightKg: '30', notes: '' },
  ];
  const { status, body } = await req('POST', '/api/user/saved-plans', {
    name: 'My Generated Push Day',
    description: 'Generated workout - intensity 7/10 (83% of 1RM)',
    exercises,
  }, aliceToken);
  assert.equal(status, 201);
  assert.ok(body.ok);
  assert.ok(body.id, 'response should include the new plan id');

  // Verify the plan appears in the user's plans list
  const { status: listStatus, body: plans } = await req('GET', '/api/user/plans', undefined, aliceToken);
  assert.equal(listStatus, 200);
  const saved = plans.find(p => p.id === body.id);
  assert.ok(saved, 'saved plan should appear in user plans list');
  assert.equal(saved.name, 'My Generated Push Day');
  assert.equal(saved.exercises.length, 2);
});
