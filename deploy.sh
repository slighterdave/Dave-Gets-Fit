#!/usr/bin/env bash
# deploy.sh – Deploy Dave-Gets-Fit to an Ubuntu server on AWS EC2.
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
REPO_URL="git@github.com:slighterdave/Dave-Gets-Fit.git"
APP_DIR="/var/www/dave-gets-fit"
NGINX_SITE="dave-gets-fit"
NGINX_CONF="/etc/nginx/sites-available/${NGINX_SITE}"
NGINX_ENABLED="/etc/nginx/sites-enabled/${NGINX_SITE}"
# ──────────────────────────────────────────────────────────────────────────────

# Ensure the script is run as root (or via sudo)
if [[ $EUID -ne 0 ]]; then
  echo "ERROR: This script must be run as root (try: sudo ./deploy.sh)" >&2
  exit 1
fi

echo "==> Updating package lists..."
apt-get update -qq

echo "==> Installing dependencies (git, nginx)..."
apt-get install -y -qq git nginx

echo "==> Deploying application to ${APP_DIR}..."
if [[ -d "${APP_DIR}/.git" ]]; then
  echo "    Repository already cloned – pulling latest changes..."
  git -C "${APP_DIR}" fetch --all --prune
  git -C "${APP_DIR}" reset --hard origin/main
else
  echo "    Cloning repository..."
  rm -rf "${APP_DIR}"
  git clone "${REPO_URL}" "${APP_DIR}"
fi

echo "==> Setting file permissions..."
chown -R www-data:www-data "${APP_DIR}"
find "${APP_DIR}" -type d -exec chmod 755 {} +
find "${APP_DIR}" -type f -exec chmod 644 {} +

echo "==> Configuring Nginx..."
cat > "${NGINX_CONF}" <<'NGINX'
server {
    listen 80 default_server;
    listen [::]:80 default_server;

    root /var/www/dave-gets-fit;
    index index.html;

    server_name _;

    # Security headers
    add_header X-Frame-Options       "SAMEORIGIN"   always;
    add_header X-Content-Type-Options "nosniff"      always;
    add_header Referrer-Policy       "strict-origin" always;

    location / {
        try_files $uri $uri/ =404;
    }

    # Deny access to hidden files and the .git directory
    location ~ /\. {
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

echo ""
PUBLIC_IP=$(curl -sf http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null || hostname -I | awk '{print $1}')
echo "✅  Deployment complete!"
echo "    The site is now being served at http://${PUBLIC_IP}"
