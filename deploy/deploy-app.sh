#!/bin/bash
set -e

echo "=========================================="
echo "Deploying Choir Voice Player Application"
echo "=========================================="
echo ""

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# Configuration
APP_DIR="/var/www/choir-voice-player"
REPO_URL="https://github.com/alexpierre9/choir-voice-player.git"

# Check if running as root
if [ "$EUID" -ne 0 ]; then
    echo -e "${RED}Please run as root (use sudo)${NC}"
    exit 1
fi

echo -e "${GREEN}Step 1: Creating application directory...${NC}"
mkdir -p $APP_DIR
cd $APP_DIR

echo -e "${GREEN}Step 2: Cloning repository...${NC}"
if [ -d ".git" ]; then
    echo "Repository already exists, pulling latest changes..."
    git pull
else
    git clone $REPO_URL .
fi

echo -e "${GREEN}Step 3: Checking for .env file...${NC}"
if [ ! -f ".env" ]; then
    echo -e "${YELLOW}Warning: .env file not found!${NC}"
    echo "Copying template..."
    cp deploy/.env.template .env
    echo -e "${RED}Please edit .env file with your configuration before continuing!${NC}"
    echo "Run: nano $APP_DIR/.env"
    exit 1
fi

echo -e "${GREEN}Step 4: Installing Node.js dependencies...${NC}"
pnpm install

# P-02: create/update the Python venv in the project directory.
# setup.sh only installs the Python interpreter; packages live in the venv.
echo -e "${GREEN}Step 4b: Setting up Python virtual environment...${NC}"
if [ ! -d "python_service/.venv" ]; then
    python3.11 -m venv python_service/.venv
fi
python_service/.venv/bin/pip install --upgrade pip --quiet
python_service/.venv/bin/pip install -r python_service/requirements.txt --quiet

echo -e "${GREEN}Step 5: Building frontend and backend...${NC}"
pnpm run build

echo -e "${GREEN}Step 6: Setting up database schema...${NC}"
pnpm db:push

# P-03: use the ecosystem.config.js already in the repo — do NOT overwrite it.
# The repo version has the correct script path (dist/index.js), venv interpreter,
# cwd, and all required env var forwarding.

echo -e "${GREEN}Step 7: Creating log directory...${NC}"
mkdir -p /var/log/choir-voice-player

echo -e "${GREEN}Step 8: Starting applications with PM2...${NC}"
# P-11: only delete this app's processes, not all PM2 processes
pm2 delete choir-satb choir-omr-service 2>/dev/null || true
pm2 start ecosystem.config.js
pm2 save

echo -e "${GREEN}Step 8b: Configuring PM2 log rotation...${NC}"
# P-07: install pm2-logrotate to prevent logs filling the disk
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 14
pm2 set pm2-logrotate:compress true
pm2 set pm2-logrotate:dateFormat YYYY-MM-DD_HH-mm-ss

echo -e "${GREEN}Step 9: Enabling PM2 startup on boot...${NC}"
pm2 startup systemd -u root --hp /root
pm2 save

echo -e "${GREEN}Step 10: Configuring Nginx...${NC}"
./deploy/configure-nginx.sh

echo -e "${GREEN}=========================================="
echo "Deployment Complete!"
echo "==========================================${NC}"
echo ""
echo "Application Status:"
pm2 status
echo ""
echo "Next steps:"
echo "1. Configure your domain DNS to point to this server"
echo "2. Run: sudo certbot --nginx -d your-domain.com"
echo "3. Check logs: pm2 logs"
echo ""
