# Copilot Instructions for Dave Gets Fit

## Project Overview

Dave Gets Fit is a personal fitness tracking web app for logging workouts, weight, and calories. It has:

- **Backend**: `server.js` – a Node.js/Express REST API using `better-sqlite3` for data persistence.
- **Frontend**: Static HTML/CSS/JS files in the `public/` directory, served by nginx (or Express in dev).
- **Database**: A single SQLite file (`data.db`) created automatically on first run.

## Architecture

```
Browser  ──HTTP──▶  nginx (port 80)
                       │
                       ├── /api/*   ──proxy──▶  Node.js / Express (port 3000)
                       │                              │
                       │                         better-sqlite3
                       │                              │
                       │                         data.db  (SQLite file)
                       │
                       └── /*       ──static──▶  public/  (HTML, CSS, JS)
```

## Key Files

| File | Purpose |
|------|---------|
| `server.js` | Express app: all API routes, auth middleware, DB setup, rate limiting |
| `public/index.html` | Main app shell |
| `public/app.js` | Frontend JS (fetch-based API calls, DOM manipulation) |
| `public/style.css` | App styles |
| `tests/server.test.js` | Integration tests using Node.js built-in test runner |
| `deploy.sh` | Automated Ubuntu deployment script |

## Development Workflow

### Install dependencies
```bash
npm install
```

### Run the dev server
```bash
npm start
# Runs on http://localhost:3000
```

### Run tests
```bash
npm test
```
Tests use Node.js's built-in test runner (`node --test`). The suite spins up the server on a random free port, runs 24 integration tests (auth, CRUD, per-user isolation), then tears down a temporary SQLite database.

## Coding Conventions

- **Style**: `'use strict'` at the top of all JS files. Single quotes for strings. 2-space indentation.
- **Backend**: Plain Node.js/Express with no TypeScript. All DB access via `better-sqlite3` prepared statements in `stmts`.
- **Auth**: JWT tokens (`jsonwebtoken`), signed with `JWT_SECRET`. Tokens expire in 7 days.
- **Passwords**: Hashed with `bcryptjs` (10 rounds). Never stored or returned in plain text.
- **Error responses**: Always return JSON `{ error: '...' }` with an appropriate HTTP status code.
- **Success responses**: Return `{ ok: true }` for mutations, or the data object/array for reads.
- **Frontend**: Vanilla HTML/CSS/JS (no frameworks). API calls use the browser `fetch` API with `Bearer` token auth.

## Database Schema

Five tables, all created automatically by `server.js` on startup:

| Table | Key | Description |
|-------|-----|-------------|
| `users` | `id` (auto-increment) | Usernames + bcrypt hashes |
| `profiles` | `user_id` | JSON blob of user profile fields |
| `workouts` | `id` (UUID) | Workout sessions (date, notes, exercises JSON) |
| `weights` | `(user_id, date)` | One entry per user per day (upsert) |
| `calories` | `id` (auto-increment) | Individual meal/food log entries |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Port for the Node.js server |
| `DB_PATH` | `<project-root>/data.db` | Path to the SQLite file |
| `JWT_SECRET` | *(auto-generated)* | JWT signing secret; set explicitly in production |
| `NODE_ENV` | *(unset)* | Set to `production` for production deployments |

## API Design

- All routes are prefixed with `/api/`.
- Protected routes require `Authorization: Bearer <token>`.
- Auth routes live under `/api/auth/` (rate-limited to 20 req/15 min).
- All other API routes are rate-limited to 300 req/15 min.
- Workout IDs are UUIDs; weight entries are keyed by `YYYY-MM-DD` date strings; calorie entries use auto-increment integer IDs.

## Testing Approach

- Integration tests only (no unit tests); they test the full HTTP stack.
- Each test file creates its own temporary SQLite database in `/tmp`.
- Tests use `node:test` and `node:assert/strict` — no external test framework.
- When adding new API endpoints, add corresponding integration tests in `tests/server.test.js`.
