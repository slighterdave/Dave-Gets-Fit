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

// ── Barcode lookup ────────────────────────────────────────────────────────────
test('barcode lookup requires auth', async () => {
  const { status } = await req('GET', '/api/food/barcode/5000112637922');
  assert.equal(status, 401);
});

test('barcode lookup returns 400 for invalid barcode format', async () => {
  const { status, body } = await req('GET', '/api/food/barcode/abc', undefined, aliceToken);
  assert.equal(status, 400);
  assert.ok(body.error);
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

// ── Trainer routes ────────────────────────────────────────────────────────────
test('setup: login carol as trainer', async () => {
  const { body } = await req('POST', '/api/auth/login', { username: 'carol', password: 'password123' });
  trainerToken = body.token;
  const payload = JSON.parse(Buffer.from(body.token.split('.')[1], 'base64url').toString());
  assert.equal(payload.role, 'trainer');
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

// ── Exercise plan routes ──────────────────────────────────────────────────
let planId;

test('setup: re-assign bob to carol for plan tests', async () => {
  const { body: users } = await req('GET', '/api/admin/users', undefined, adminToken);
  const bobUser = users.find(u => u.username === 'bob');
  const { status } = await req('POST', '/api/admin/assignments', { trainerId: carolId, userId: bobUser.id }, adminToken);
  assert.equal(status, 201);
});

test('trainer can create an exercise plan', async () => {
  const plan = {
    name: 'Beginner Strength',
    exercises: [
      { name: 'Squat', sets: '3', reps: '10', weightKg: '60' },
      { name: 'Bench Press', sets: '3', reps: '8', weightKg: '50' },
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

test('create plan returns 400 when name missing', async () => {
  const { status, body } = await req('POST', '/api/trainer/plans', { exercises: [{ name: 'Squat' }] }, trainerToken);
  assert.equal(status, 400);
  assert.ok(body.error);
});

test('create plan returns 400 when exercises empty', async () => {
  const { status, body } = await req('POST', '/api/trainer/plans', { name: 'Empty Plan', exercises: [] }, trainerToken);
  assert.equal(status, 400);
  assert.ok(body.error);
});

test('regular user cannot create plans', async () => {
  const { body: bobAuth } = await req('POST', '/api/auth/login', { username: 'bob', password: 'password123' });
  const { status } = await req('POST', '/api/trainer/plans', { name: 'Test', exercises: [{ name: 'Squat' }] }, bobAuth.token);
  assert.equal(status, 403);
});

test('trainer can assign a plan to an assigned user', async () => {
  const { body: users } = await req('GET', '/api/trainer/users', undefined, trainerToken);
  const bobId = users[0].id;
  const { status, body } = await req('POST', `/api/trainer/users/${bobId}/plans`, { planId }, trainerToken);
  assert.equal(status, 201);
  assert.equal(body.ok, true);
});

test('trainer can view plans assigned to a user', async () => {
  const { body: users } = await req('GET', '/api/trainer/users', undefined, trainerToken);
  const bobId = users[0].id;
  const { status, body } = await req('GET', `/api/trainer/users/${bobId}/plans`, undefined, trainerToken);
  assert.equal(status, 200);
  assert.ok(Array.isArray(body));
  assert.equal(body.length, 1);
  assert.equal(body[0].name, 'Beginner Strength');
});

test('user can view their own assigned plans', async () => {
  const { body: bobAuth } = await req('POST', '/api/auth/login', { username: 'bob', password: 'password123' });
  const { status, body } = await req('GET', '/api/plans', undefined, bobAuth.token);
  assert.equal(status, 200);
  assert.ok(Array.isArray(body));
  assert.equal(body.length, 1);
  assert.equal(body[0].name, 'Beginner Strength');
  assert.ok(Array.isArray(body[0].exercises));
});

test('plans endpoint requires auth', async () => {
  const { status } = await req('GET', '/api/plans');
  assert.equal(status, 401);
});

test('trainer can unassign a plan from a user', async () => {
  const { body: users } = await req('GET', '/api/trainer/users', undefined, trainerToken);
  const bobId = users[0].id;
  const { status, body } = await req('DELETE', `/api/trainer/users/${bobId}/plans/${planId}`, undefined, trainerToken);
  assert.equal(status, 200);
  assert.equal(body.ok, true);

  const { body: plans } = await req('GET', `/api/trainer/users/${bobId}/plans`, undefined, trainerToken);
  assert.equal(plans.length, 0);
});

test('trainer can delete a plan', async () => {
  const { status, body } = await req('DELETE', `/api/trainer/plans/${planId}`, undefined, trainerToken);
  assert.equal(status, 200);
  assert.equal(body.ok, true);

  const { body: plans } = await req('GET', '/api/trainer/plans', undefined, trainerToken);
  assert.equal(plans.length, 0);
});

test('trainer cannot delete another trainer\'s plan', async () => {
  // Create a plan as carol
  const { body: created } = await req('POST', '/api/trainer/plans', { name: 'Carol Plan', exercises: [{ name: 'Run' }] }, trainerToken);
  // Alice is admin (also passes requireTrainer) but did not create this plan
  const { status } = await req('DELETE', `/api/trainer/plans/${created.id}`, undefined, adminToken);
  assert.equal(status, 404);
  // Clean up
  await req('DELETE', `/api/trainer/plans/${created.id}`, undefined, trainerToken);
});
