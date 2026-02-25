#!/bin/bash
set -e

echo "=========================================="
echo "Nginx Configuration"
echo "=========================================="
echo ""

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# Check if running as root
if [ "$EUID" -ne 0 ]; then
    echo -e "${RED}Please run as root (use sudo)${NC}"
    exit 1
fi

# Prompt for domain
read -p "Enter your domain name (e.g., choir.example.com): " DOMAIN

if [ -z "$DOMAIN" ]; then
    echo "Domain name is required!"
    exit 1
fi

echo -e "${GREEN}Creating Nginx configuration for ${DOMAIN}...${NC}"

cat > /etc/nginx/sites-available/choir-voice-player <<EOF
# P-06: enable gzip for text assets (JS bundles, CSS, JSON)
gzip on;
gzip_types text/html text/plain text/css text/javascript
           application/javascript application/json application/wasm
           image/svg+xml font/woff font/woff2;
gzip_min_length 1000;
gzip_comp_level 6;
gzip_vary on;

server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};

    # --- Security headers ---
    # P-05: removed deprecated X-XSS-Protection (ignored/harmful in modern browsers)
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    # P-05: HSTS — tells browsers to only connect via HTTPS for 1 year
    #       Certbot will keep this header when it adds the 443 block.
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    # P-05: reduce referrer info sent to third parties
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    # P-10: Content Security Policy
    #       If you enable analytics (VITE_ANALYTICS_ENDPOINT), add that domain
    #       to script-src and connect-src below.
    add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self'; connect-src 'self'; media-src 'self' blob:; worker-src 'self' blob:; object-src 'none'; frame-ancestors 'self';" always;

    # Client max body size (for file uploads — must match server body parser limit)
    client_max_body_size 50M;

    # Proxy to Node.js application
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;

        # Timeouts generous enough for a 50 MB upload on a slow connection
        proxy_connect_timeout 600;
        proxy_send_timeout 600;
        proxy_read_timeout 600;
        send_timeout 600;
    }

    # Long-lived caching for Vite-hashed static assets
    location ~* \.(js|css|woff|woff2|ttf|eot)$ {
        proxy_pass http://localhost:3000;
        expires 1y;
        add_header Cache-Control "public, immutable";
        # Repeat security headers — Nginx only sends add_header directives from
        # the most specific block, so they must be repeated in nested locations.
        add_header X-Frame-Options "SAMEORIGIN" always;
        add_header X-Content-Type-Options "nosniff" always;
        add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
        add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    }

    # Access and error logs
    access_log /var/log/nginx/choir-voice-player-access.log;
    error_log /var/log/nginx/choir-voice-player-error.log;
}
EOF

echo -e "${GREEN}Enabling site...${NC}"
ln -sf /etc/nginx/sites-available/choir-voice-player /etc/nginx/sites-enabled/

echo -e "${GREEN}Testing Nginx configuration...${NC}"
nginx -t

echo -e "${GREEN}Reloading Nginx...${NC}"
systemctl reload nginx

echo -e "${GREEN}Nginx configured successfully!${NC}"
echo ""
echo -e "${YELLOW}To enable SSL (recommended), run:${NC}"
echo "sudo certbot --nginx -d ${DOMAIN}"
echo ""
echo -e "${YELLOW}After certbot: verify Strict-Transport-Security is present in the 443 block.${NC}"
echo ""
