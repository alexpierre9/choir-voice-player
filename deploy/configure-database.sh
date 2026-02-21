#!/bin/bash
set -e

echo "=========================================="
echo "MySQL Database Configuration"
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

# Prompt for database details
read -p "Enter database name [choir_voice_player]: " DB_NAME
DB_NAME=${DB_NAME:-choir_voice_player}

read -p "Enter database username [choirapp]: " DB_USER
DB_USER=${DB_USER:-choirapp}

read -sp "Enter database password: " DB_PASS
echo ""

read -sp "Enter MySQL root password (leave empty if not set): " MYSQL_ROOT_PASS
echo ""

echo -e "${GREEN}Creating database and user...${NC}"

if [ -z "$MYSQL_ROOT_PASS" ]; then
    mysql <<EOF
CREATE DATABASE IF NOT EXISTS ${DB_NAME} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '${DB_USER}'@'localhost' IDENTIFIED BY '${DB_PASS}';
GRANT ALL PRIVILEGES ON ${DB_NAME}.* TO '${DB_USER}'@'localhost';
FLUSH PRIVILEGES;
EOF
else
    mysql -u root -p"${MYSQL_ROOT_PASS}" <<EOF
CREATE DATABASE IF NOT EXISTS ${DB_NAME} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '${DB_USER}'@'localhost' IDENTIFIED BY '${DB_PASS}';
GRANT ALL PRIVILEGES ON ${DB_NAME}.* TO '${DB_USER}'@'localhost';
FLUSH PRIVILEGES;
EOF
fi

echo -e "${GREEN}Database created successfully!${NC}"
echo ""
echo "Database connection string:"
echo "mysql://${DB_USER}:${DB_PASS}@localhost:3306/${DB_NAME}"
echo ""
echo -e "${YELLOW}Save this connection string for your .env file!${NC}"

