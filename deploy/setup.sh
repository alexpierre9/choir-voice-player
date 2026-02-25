#!/bin/bash
set -e

echo "=========================================="
echo "Choir Voice Player - VPS Deployment Setup"
echo "=========================================="
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if running as root
if [ "$EUID" -ne 0 ]; then 
    echo -e "${RED}Please run as root (use sudo)${NC}"
    exit 1
fi

echo -e "${GREEN}Step 1: Updating system packages...${NC}"
apt-get update
apt-get upgrade -y

echo -e "${GREEN}Step 2: Installing required system packages...${NC}"
apt-get install -y curl wget git build-essential nginx certbot python3-certbot-nginx

echo -e "${GREEN}Step 3: Installing Node.js 22...${NC}"
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

echo -e "${GREEN}Step 4: Installing pnpm...${NC}"
npm install -g pnpm pm2

echo -e "${GREEN}Step 5: Installing Python 3.11 and pip...${NC}"
apt-get install -y python3.11 python3.11-venv python3-pip python3.11-dev

# P-02: Python app packages are installed into the project venv by deploy-app.sh
# after the repo is cloned. Do NOT install them globally here.

echo -e "${GREEN}Step 7: Installing MySQL...${NC}"
apt-get install -y mysql-server
systemctl start mysql
systemctl enable mysql

echo -e "${GREEN}Step 8: Installing additional dependencies for OMR...${NC}"
apt-get install -y poppler-utils

echo -e "${YELLOW}=========================================="
echo "System setup complete!"
echo "==========================================${NC}"
echo ""
echo "Next steps:"
echo "1. Run ./configure-database.sh to set up MySQL"
echo "2. Edit .env file with your configuration"
echo "3. Run ./deploy-app.sh to deploy the application"
echo ""

