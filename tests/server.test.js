'use strict';

/**
 * Integration tests for the Dave Gets Fit backend API.
 * Uses Node.js built-in test runner (node --test).
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http   = require('node:http');
const path   = require('node:path');
const fs     = require('node:fs');

// Use a temp database for tests
process.env.DB_PATH = path.join('/tmp', `dgf_test_${Date.now()}.db`);
process.env.JWT_SECRET = 'test-secret-for-unit-tests-only';
process.env.PORT = '0'; // Let OS pick a free port

// Load the app (it calls app.listen internally; we grab the server via module.exports)
const app = require('../server.js');

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
