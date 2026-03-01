#!/usr/bin/env bash
# deploy.sh – Deploy GetUs.Fit to an Ubuntu server on AWS EC2.
#
# Usage (first time):
#   chmod +x deploy.sh
#   sudo ./deploy.sh
#
# The script is safe to re-run for subsequent deployments; it will pull
# the latest code each time it is executed.
#
# Prerequisites on the EC2 instance:
#   • Ubuntu 20.04 / 22.04 / 24.04
#   • Inbound TCP 80 (and optionally 443) open in the EC2 Security Group
#   • The instance must be able to reach github.com (outbound TCP 443)

set -euo pipefail

# ── Configuration ─────────────────────────────────────────────────────────────
REPO_URL="https://github.com/slighterdave/Dave-Gets-Fit.git"
APP_DIR="/var/www/getus-fit"
APP_USER="ubuntu"
NGINX_SITE="getus-fit"
NGINX_CONF="/etc/nginx/sites-available/${NGINX_SITE}"
NGINX_ENABLED="/etc/nginx/sites-enabled/${NGINX_SITE}"
SERVICE_NAME="getus-fit"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
NODE_PORT=3000
# Public domain name – used to obtain a Let's Encrypt TLS certificate.
# Override at runtime if needed: DOMAIN=other.example.com sudo ./deploy.sh
DOMAIN="${DOMAIN:-getus.fit}"
# Email address for Let's Encrypt expiry notifications (optional but recommended).
#   LE_EMAIL=you@example.com DOMAIN=... sudo ./deploy.sh
LE_EMAIL="${LE_EMAIL:-}"
# ──────────────────────────────────────────────────────────────────────────────

# Ensure the script is run as root (or via sudo)
if [[ $EUID -ne 0 ]]; then
  echo "ERROR: This script must be run as root (try: sudo ./deploy.sh)" >&2
  exit 1
fi

echo "==> Updating package lists..."
apt-get update -qq

echo "==> Installing dependencies (git, nginx, nodejs, certbot)..."
apt-get install -y -qq git nginx curl certbot python3-certbot-nginx

# Install Node.js 20.x LTS if not already installed or version is too old
if ! command -v node &>/dev/null || [[ "$(node -e 'process.exit(parseInt(process.version.slice(1)) < 18 ? 1 : 0)' ; echo $?)" == "1" ]]; then
  echo "==> Installing Node.js 20.x LTS..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs
fi

echo "==> Node.js version: $(node --version)"
echo "==> npm version:     $(npm --version)"

echo "==> Deploying application to ${APP_DIR}..."
git config --system --add safe.directory "${APP_DIR}"
if [[ -d "${APP_DIR}/.git" ]]; then
  echo "    Repository already cloned – pulling latest changes..."
  chown -R ${APP_USER}:${APP_USER} "${APP_DIR}"
  sudo -u ${APP_USER} git -C "${APP_DIR}" fetch --all --prune
  sudo -u ${APP_USER} git -C "${APP_DIR}" reset --hard origin/main
else
  echo "    Cloning repository..."
  rm -rf "${APP_DIR}"
  mkdir -p "${APP_DIR}"
  chown ${APP_USER}:${APP_USER} "${APP_DIR}"
  sudo -u ${APP_USER} git clone "${REPO_URL}" "${APP_DIR}"
fi

echo "==> Installing Node.js dependencies..."
sudo -u ${APP_USER} npm --prefix "${APP_DIR}" ci --omit=dev

echo "==> Setting file permissions..."
chown -R ${APP_USER}:${APP_USER} "${APP_DIR}"
find "${APP_DIR}" -type d -exec chmod 755 {} +
find "${APP_DIR}" -type f -exec chmod 644 {} +
chmod 755 "${APP_DIR}/server.js"

echo "==> Configuring systemd service..."
cat > "${SERVICE_FILE}" <<SERVICE
[Unit]
Description=GetUs.Fit backend
After=network.target

[Service]
Type=simple
User=${APP_USER}
WorkingDirectory=${APP_DIR}
ExecStart=/usr/bin/node ${APP_DIR}/server.js
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production
Environment=PORT=${NODE_PORT}
Environment=DB_PATH=${APP_DIR}/data.db

[Install]
WantedBy=multi-user.target
SERVICE

systemctl daemon-reload
systemctl enable "${SERVICE_NAME}"
systemctl restart "${SERVICE_NAME}"
echo "    Backend service started."

echo "==> Configuring Nginx..."
cat > "${NGINX_CONF}" <<NGINX
server {
    listen 80 default_server;
    listen [::]:80 default_server;

    server_name ${DOMAIN:-_} www.${DOMAIN:-_};

    # Security headers
    add_header X-Frame-Options       "SAMEORIGIN"   always;
    add_header X-Content-Type-Options "nosniff"      always;
    add_header Referrer-Policy       "strict-origin" always;

    # Proxy API requests to the Node.js backend
    location /api/ {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Host              \$host;
        proxy_set_header   X-Real-IP         \$remote_addr;
        proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
    }

    # Serve static frontend files
    root /var/www/getus-fit/public;
    index index.html;

    location / {
        try_files \$uri \$uri/ =404;
    }

    # Deny access to hidden files, the .git directory, and server-side files
    location ~ /\\. {
        deny all;
    }

    location ~* \\.(db)\$ {
        deny all;
    }
}
NGINX

# Enable the site and remove the default if it exists
ln -sf "${NGINX_CONF}" "${NGINX_ENABLED}"
if [[ -f /etc/nginx/sites-enabled/default ]]; then
  rm -f /etc/nginx/sites-enabled/default
fi

echo "==> Testing Nginx configuration..."
nginx -t

echo "==> Reloading Nginx..."
systemctl enable nginx
systemctl is-active --quiet nginx && systemctl reload nginx || systemctl restart nginx

# Obtain a TLS certificate and enable HTTPS if a domain was supplied
if [[ -n "${DOMAIN}" ]]; then
  echo "==> Obtaining TLS certificate from Let's Encrypt for ${DOMAIN} and www.${DOMAIN}..."
  CERTBOT_ARGS=(--nginx -d "${DOMAIN}" -d "www.${DOMAIN}" --non-interactive --agree-tos --redirect)
  if [[ -n "${LE_EMAIL}" ]]; then
    CERTBOT_ARGS+=(--email "${LE_EMAIL}")
  else
    CERTBOT_ARGS+=(--register-unsafely-without-email)
  fi
  certbot "${CERTBOT_ARGS[@]}"
  echo "    HTTPS certificate installed. Auto-renewal is handled by the certbot systemd timer."
fi

echo ""
PUBLIC_IP=$(curl -sf http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null || hostname -I | awk '{print $1}')
echo "✅  Deployment complete!"
if [[ -n "${DOMAIN}" ]]; then
  echo "    The site is now being served at https://${DOMAIN}"
else
  echo "    The site is now being served at http://${PUBLIC_IP}"
  echo "    Tip: re-run with DOMAIN=your.domain.com to enable HTTPS."
fi
