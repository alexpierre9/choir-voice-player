#!/bin/bash
set -e

echo "=========================================="
echo "Nginx Configuration"
echo "=========================================="
echo ""

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
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
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};

    # Security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;

    # Client max body size (for file uploads)
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
        
        # Timeouts for long-running requests
        proxy_connect_timeout 600;
        proxy_send_timeout 600;
        proxy_read_timeout 600;
        send_timeout 600;
    }

    # Static files caching
    location ~* \.(jpg|jpeg|png|gif|ico|css|js|svg|woff|woff2|ttf|eot)$ {
        proxy_pass http://localhost:3000;
        expires 1y;
        add_header Cache-Control "public, immutable";
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
echo -e "${YELLOW}To enable SSL, run:${NC}"
echo "sudo certbot --nginx -d ${DOMAIN}"
echo ""

