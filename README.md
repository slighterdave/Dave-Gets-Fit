# GetUs.Fit

A personal fitness tracking web app for logging workouts, weight, and calories. Built with a Node.js/Express backend, a SQLite database, and a plain HTML/CSS/JS frontend served by nginx.

---

## Table of Contents

1. [Architecture](#architecture)
2. [Local Development](#local-development)
3. [Ubuntu Deployment](#ubuntu-deployment)
   - [Prerequisites](#prerequisites)
   - [Option A – Automated (recommended)](#option-a--automated-recommended)
   - [Option B – Manual step-by-step](#option-b--manual-step-by-step)
4. [SQLite Database](#sqlite-database)
   - [Location](#location)
   - [Schema](#schema)
   - [Inspecting the database](#inspecting-the-database)
   - [Backup and restore](#backup-and-restore)
5. [Environment Variables](#environment-variables)
6. [Running Tests](#running-tests)
7. [API Reference](#api-reference)

---

## Architecture

```
Browser  ──HTTPS──▶  nginx (port 443, TLS via Let's Encrypt)
                       │  (port 80 redirects to 443)
                       │
                       ├── /api/*   ──proxy──▶  Node.js / Express (port 3000)
                       │                              │
                       │                         better-sqlite3
                       │                              │
                       │                         data.db  (SQLite file)
                       │
                       └── /*       ──static──▶  public/  (HTML, CSS, JS)
```

- **Frontend** – static files in `public/`, served by nginx.
- **Backend** – `server.js` (Express), handles REST API requests and manages the SQLite database.
- **Database** – a single SQLite file (`data.db`). No separate database server is required; SQLite runs inside the Node.js process via `better-sqlite3`.

---

## Local Development

**Requirements:** Node.js ≥ 18, npm.

```bash
# 1. Clone the repository
git clone https://github.com/slighterdave/Dave-Gets-Fit.git
cd Dave-Gets-Fit

# 2. Install dependencies
npm install

# 3. Start the development server (creates data.db automatically)
npm start
# Server is now running at http://localhost:3000
```

Open `http://localhost:3000` in your browser. The SQLite database file (`data.db`) is created automatically in the project root on first start.

---

## Ubuntu Deployment

### Prerequisites

- Ubuntu 20.04, 22.04, or 24.04
- A server/VM with at least 512 MB RAM
- Inbound TCP port **80** and **443** open in your firewall / EC2 Security Group
- The domain `getus.fit` **and** `www.getus.fit` pointed at the server's public IP (A records for both)
- Outbound TCP port **443** to reach `github.com` and `deb.nodesource.com`
- Root or `sudo` access

---

### Option A – Automated (recommended)

The included `deploy.sh` script handles everything: installing Node.js, cloning/updating the repo, installing npm dependencies, creating a systemd service for the backend, and configuring nginx.

```bash
# Run once on the server (re-running is safe – it pulls the latest code each time)
sudo bash deploy.sh
```

What the script does:
1. Installs `git`, `nginx`, `curl`, `certbot`, `python3-certbot-nginx`, and **Node.js 20.x LTS** (via the NodeSource repository).
2. Clones the repository to `/var/www/getus-fit` (or pulls the latest changes if already cloned).
3. Runs `npm ci --omit=dev` to install production dependencies.
4. Creates and enables a **systemd service** (`getus-fit`) that starts the Node.js backend on port 3000 and restarts it automatically on failure.
5. Writes an **nginx virtual-host** that:
   - Proxies `/api/*` requests to the Node.js backend.
   - Serves the static frontend from `/var/www/getus-fit/public/`.
   - Denies access to hidden files and `.db` files.
6. Runs **Certbot** to obtain a free Let's Encrypt TLS certificate covering both `getus.fit` and `www.getus.fit`, configures nginx for HTTPS on port 443, and sets up an HTTP → HTTPS redirect. Certificate renewal is handled automatically by the certbot systemd timer.

After the script finishes it prints the URL where the site is live (`https://getus.fit`).

To use a different domain or supply a notification email for certificate expiry alerts:

```bash
DOMAIN=other.example.com LE_EMAIL=you@example.com sudo bash deploy.sh
```

---

### Option B – Manual step-by-step

Follow these steps if you prefer to set everything up yourself.

#### 1. Update packages and install system dependencies

```bash
sudo apt-get update
sudo apt-get install -y git nginx curl
```

#### 2. Install Node.js 20.x LTS

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version   # should print v20.x.x
```

#### 3. Clone the repository

```bash
sudo mkdir -p /var/www/getus-fit
sudo chown ubuntu:ubuntu /var/www/getus-fit
git clone https://github.com/slighterdave/Dave-Gets-Fit.git /var/www/getus-fit
cd /var/www/getus-fit
```

#### 4. Install production Node.js dependencies

```bash
npm ci --omit=dev
```

This installs Express, better-sqlite3, jsonwebtoken, bcryptjs, and express-rate-limit into `node_modules/`. The SQLite database itself is embedded — no separate installation is needed.

#### 5. Start the backend once to verify it works

```bash
node server.js
# GetUs.Fit server running on http://localhost:3000
# Press Ctrl+C to stop
```

#### 6. Create a systemd service so the backend starts automatically

```bash
sudo tee /etc/systemd/system/getus-fit.service > /dev/null <<'EOF'
[Unit]
Description=GetUs.Fit backend
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/var/www/getus-fit
ExecStart=/usr/bin/node /var/www/getus-fit/server.js
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production
Environment=PORT=3000
Environment=DB_PATH=/var/www/getus-fit/data.db

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable getus-fit
sudo systemctl start getus-fit
sudo systemctl status getus-fit   # should show "active (running)"
```

#### 7. Configure nginx

```bash
sudo tee /etc/nginx/sites-available/getus-fit > /dev/null <<'EOF'
server {
    listen 80 default_server;
    listen [::]:80 default_server;

    server_name _;

    add_header X-Frame-Options        "SAMEORIGIN"   always;
    add_header X-Content-Type-Options "nosniff"      always;
    add_header Referrer-Policy        "strict-origin" always;

    location /api/ {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }

    root  /var/www/getus-fit/public;
    index index.html;

    location / {
        try_files $uri $uri/ =404;
    }

    location ~ /\. {
        deny all;
    }

    location ~* \.(db)$ {
        deny all;
    }
}
EOF

sudo ln -sf /etc/nginx/sites-available/getus-fit \
            /etc/nginx/sites-enabled/getus-fit
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t        # test configuration
sudo systemctl enable nginx
sudo systemctl restart nginx
```

The site is now live on port 80. The Node.js process creates `data.db` automatically on first start.

---

## SQLite Database

### Location

| Context | Path |
|---------|------|
| Local development | `<project-root>/data.db` |
| Production (default) | `/var/www/getus-fit/data.db` |

The path can be overridden with the `DB_PATH` environment variable (see [Environment Variables](#environment-variables)).

### Schema

The database is created automatically by `server.js` on first run using `CREATE TABLE IF NOT EXISTS` statements. The five tables are:

| Table | Primary key | Description |
|-------|-------------|-------------|
| `users` | `id` (auto-increment) | Usernames and bcrypt password hashes |
| `profiles` | `user_id` | JSON blob of each user's profile fields |
| `workouts` | `id` (UUID) | Workout sessions (date, notes, exercises JSON) |
| `weights` | `(user_id, date)` | One weight entry per user per day (upsert) |
| `calories` | `id` (auto-increment) | Individual meal/food log entries |

### Inspecting the database

Install the `sqlite3` command-line tool:

```bash
sudo apt-get install -y sqlite3
```

Open the database:

```bash
sqlite3 /var/www/getus-fit/data.db
```

Useful commands inside the SQLite shell:

```sql
-- List all tables
.tables

-- Show the schema
.schema

-- View all registered users (passwords are hashed, never stored in plain text)
SELECT id, username FROM users;

-- Count records per user
SELECT u.username,
       COUNT(DISTINCT w.id)   AS workouts,
       COUNT(DISTINCT wt.date) AS weight_entries,
       COUNT(DISTINCT c.id)   AS calorie_entries
FROM users u
LEFT JOIN workouts  w  ON w.user_id  = u.id
LEFT JOIN weights   wt ON wt.user_id = u.id
LEFT JOIN calories  c  ON c.user_id  = u.id
GROUP BY u.id;

-- Exit the shell
.quit
```

The database runs in **WAL (Write-Ahead Logging)** mode, which is set automatically by `server.js` on startup. This improves concurrent read performance. WAL mode produces two additional temporary files alongside `data.db`:

- `data.db-wal` – the write-ahead log
- `data.db-shm` – the shared-memory file

These are normal and are managed automatically; do not delete them while the server is running.

### Backup and restore

**Online backup (recommended while the server is running):**

```bash
# Creates a consistent snapshot even while the app is writing
sqlite3 /var/www/getus-fit/data.db \
  "VACUUM INTO '/var/backups/getus-fit-$(date +%F).db'"
```

**Offline backup (server stopped):**

```bash
sudo systemctl stop getus-fit
cp /var/www/getus-fit/data.db /var/backups/getus-fit-$(date +%F).db
sudo systemctl start getus-fit
```

**Restore from backup:**

```bash
sudo systemctl stop getus-fit
cp /var/backups/getus-fit-<DATE>.db /var/www/getus-fit/data.db
# Remove WAL files so SQLite starts clean
rm -f /var/www/getus-fit/data.db-wal \
      /var/www/getus-fit/data.db-shm
sudo systemctl start getus-fit
```

**Automated daily backups with cron:**

Create a backup script:

```bash
sudo tee /usr/local/bin/dgf-backup.sh > /dev/null <<'EOF'
#!/usr/bin/env bash
BACKUP_DIR="/var/backups/getus-fit"
mkdir -p "$BACKUP_DIR"
sqlite3 /var/www/getus-fit/data.db \
  "VACUUM INTO '${BACKUP_DIR}/data-$(date +%F).db'"
# Keep only the last 30 daily backups
find "$BACKUP_DIR" -name 'data-*.db' -mtime +30 -delete
EOF
sudo chmod +x /usr/local/bin/dgf-backup.sh
```

Schedule it with cron (runs every day at 02:00):

```bash
sudo crontab -e
# Add this line:
0 2 * * * /usr/local/bin/dgf-backup.sh
```

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | TCP port the Node.js server listens on |
| `DB_PATH` | `<project-root>/data.db` | Absolute path to the SQLite database file |
| `JWT_SECRET` | *(auto-generated)* | Secret used to sign JWT tokens. If not set, a random 96-character hex string is generated and saved to `.jwt_secret` in the project root. Set this explicitly in production for predictable key rotation. |
| `NODE_ENV` | *(unset)* | Set to `production` for production deployments |

Set variables in the systemd service file under `[Service]`:

```ini
Environment=JWT_SECRET=your-long-random-secret-here
Environment=DB_PATH=/var/www/getus-fit/data.db
```

Then reload the service:

```bash
sudo systemctl daemon-reload
sudo systemctl restart getus-fit
```

---

## Running Tests

```bash
npm test
```

The test suite uses Node.js's built-in test runner (`node --test`). It starts the server on a random free port, runs 24 integration tests covering auth, all CRUD endpoints, and per-user data isolation, then tears down and cleans up a temporary test database.

---

## API Reference

All API routes are prefixed with `/api/`. Protected routes require a `Bearer <token>` header obtained from the login or register endpoints.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/auth/register` | — | Create a new account. Returns `{ token }`. |
| `POST` | `/api/auth/login` | — | Log in. Returns `{ token }`. |
| `GET` | `/api/profile` | ✓ | Get the current user's profile. |
| `PUT` | `/api/profile` | ✓ | Save / update the current user's profile. |
| `DELETE` | `/api/user/data` | ✓ | Delete all fitness data (keeps account). |
| `GET` | `/api/workouts` | ✓ | List all workout sessions. |
| `POST` | `/api/workouts` | ✓ | Log a new workout session. |
| `DELETE` | `/api/workouts/:id` | ✓ | Delete a workout by ID. |
| `GET` | `/api/weights` | ✓ | List all weight entries. |
| `POST` | `/api/weights` | ✓ | Log a weight entry (upsert by date). |
| `DELETE` | `/api/weights/:date` | ✓ | Delete a weight entry by date (`YYYY-MM-DD`). |
| `GET` | `/api/calories` | ✓ | List all calorie/meal entries. |
| `POST` | `/api/calories` | ✓ | Log a new meal. |
| `DELETE` | `/api/calories/:id` | ✓ | Delete a meal entry by ID. |
