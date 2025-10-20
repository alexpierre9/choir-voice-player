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

echo -e "${GREEN}Step 5: Building frontend...${NC}"
pnpm run build

echo -e "${GREEN}Step 6: Setting up database schema...${NC}"
pnpm db:push

echo -e "${GREEN}Step 7: Creating PM2 ecosystem file...${NC}"
cat > ecosystem.config.js <<'EOF'
module.exports = {
  apps: [
    {
      name: 'choir-voice-player-web',
      script: 'server/index.js',
      cwd: '/var/www/choir-voice-player',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        PORT: 3000
      },
      error_file: '/var/log/choir-voice-player/web-error.log',
      out_file: '/var/log/choir-voice-player/web-out.log',
      time: true
    },
    {
      name: 'choir-voice-player-python',
      script: 'python3.11',
      args: 'python_service/music_processor.py',
      cwd: '/var/www/choir-voice-player',
      instances: 1,
      exec_mode: 'fork',
      env: {
        PYTHON_SERVICE_PORT: 8001
      },
      error_file: '/var/log/choir-voice-player/python-error.log',
      out_file: '/var/log/choir-voice-player/python-out.log',
      time: true
    }
  ]
};
EOF

echo -e "${GREEN}Step 8: Creating log directory...${NC}"
mkdir -p /var/log/choir-voice-player

echo -e "${GREEN}Step 9: Starting applications with PM2...${NC}"
pm2 delete all || true
pm2 start ecosystem.config.js
pm2 save
pm2 startup systemd -u root --hp /root

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

