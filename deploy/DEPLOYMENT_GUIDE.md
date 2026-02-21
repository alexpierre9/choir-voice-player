# Hostinger VPS Deployment Guide

Complete guide to deploy Choir Voice Player on your Hostinger VPS.

## Prerequisites

Before starting, ensure you have:

1. **Hostinger VPS** with Ubuntu 20.04 or 22.04
2. **Root/sudo access** to your VPS
3. **Domain name** pointed to your VPS IP address
4. **S3 Storage Account** (AWS S3, Backblaze B2, or DigitalOcean Spaces)
5. **SSH client** to connect to your VPS

### Minimum VPS Requirements

- **RAM**: 2GB minimum (4GB recommended)
- **Storage**: 20GB minimum
- **CPU**: 2 cores recommended
- **OS**: Ubuntu 20.04/22.04 LTS

## Step-by-Step Deployment

### Step 1: Connect to Your VPS

```bash
ssh root@your-vps-ip
```

### Step 2: Clone the Repository

```bash
cd /tmp
git clone https://github.com/alexpierre9/choir-voice-player.git
cd choir-voice-player/deploy
```

### Step 3: Make Scripts Executable

```bash
chmod +x setup.sh configure-database.sh deploy-app.sh configure-nginx.sh
```

### Step 4: Run System Setup

This installs Node.js, Python, MySQL, Nginx, and all dependencies:

```bash
sudo ./setup.sh
```

**This will take 5-10 minutes.** The script will:
- Update system packages
- Install Node.js 22 and pnpm
- Install Python 3.11 and required libraries
- Install MySQL database
- Install Nginx web server
- Install OMR dependencies

### Step 5: Configure Database

```bash
sudo ./configure-database.sh
```

You'll be prompted for:
- Database name (default: `choir_voice_player`)
- Database username (default: `choirapp`)
- Database password (create a strong password)
- MySQL root password (if set)

**Save the database connection string** that appears at the end!

### Step 6: Set Up S3 Storage

You need an S3-compatible storage service. Choose one:

#### Option A: AWS S3

1. Go to https://console.aws.amazon.com/s3/
2. Create a new bucket (e.g., `choir-voice-player`)
3. Go to IAM → Users → Create user
4. Attach policy: `AmazonS3FullAccess`
5. Create access key → Save the credentials

#### Option B: Backblaze B2 (Cheaper alternative)

1. Go to https://www.backblaze.com/b2/
2. Create account and bucket
3. Create application key
4. Note the endpoint: `https://s3.us-west-002.backblazeb2.com`

#### Option C: DigitalOcean Spaces

1. Go to https://cloud.digitalocean.com/spaces
2. Create a new Space
3. Generate API keys
4. Note the endpoint: `https://nyc3.digitaloceanspaces.com`

### Step 7: Configure Environment Variables

```bash
cd /var/www/choir-voice-player
cp deploy/.env.template .env
nano .env
```

Edit the following values:

```env
# Database (from Step 5)
DATABASE_URL=<SECURE_PASSWORD>

# JWT Secret (generate with: openssl rand -base64 32)
JWT_SECRET=your-generated-secret-here

# S3 Storage (from Step 6)
AWS_ACCESS_KEY_ID=your-access-key
AWS_SECRET_ACCESS_KEY=your-secret-key
AWS_REGION=us-east-1
AWS_BUCKET_NAME=choir-voice-player
AWS_ENDPOINT=https://s3.amazonaws.com

# Domain
DOMAIN=your-domain.com
```

**For OAuth (Optional):**
If you're not using the Manus OAuth system, you'll need to either:
- Set up your own OAuth provider (Auth0, Firebase, etc.)
- Modify the authentication system to use email/password
- Use a different authentication method

For now, you can leave OAuth fields empty and implement alternative auth later.

Save and exit (Ctrl+X, Y, Enter)

### Step 8: Deploy the Application

```bash
cd /var/www/choir-voice-player/deploy
sudo ./deploy-app.sh
```

This will:
- Clone the repository to `/var/www/choir-voice-player`
- Install dependencies
- Build the frontend
- Set up the database schema
- Start both Node.js and Python services with PM2
- Configure Nginx

### Step 9: Configure SSL Certificate

After your domain DNS is pointing to your VPS:

```bash
sudo certbot --nginx -d your-domain.com
```

Follow the prompts to:
- Enter your email
- Agree to terms
- Choose to redirect HTTP to HTTPS (recommended)

### Step 10: Verify Deployment

Check if services are running:

```bash
pm2 status
```

You should see:
- `choir-voice-player-web` (Node.js server)
- `choir-voice-player-python` (Python service)

Check logs:

```bash
pm2 logs
```

Test the application:

```bash
curl http://localhost:3000
```

Visit your domain in a browser:

```
https://your-domain.com
```

## Post-Deployment

### Managing the Application

**View logs:**
```bash
pm2 logs choir-voice-player-web
pm2 logs choir-voice-player-python
```

**Restart services:**
```bash
pm2 restart all
```

**Stop services:**
```bash
pm2 stop all
```

**Update application:**
```bash
cd /var/www/choir-voice-player
git pull
pnpm install
pnpm run build
pnpm db:push
pm2 restart all
```

### Monitoring

**Check disk space:**
```bash
df -h
```

**Check memory usage:**
```bash
free -h
```

**Check CPU usage:**
```bash
top
```

**Check Nginx status:**
```bash
systemctl status nginx
```

**Check MySQL status:**
```bash
systemctl status mysql
```

### Firewall Configuration

If you have a firewall enabled:

```bash
sudo ufw allow 22/tcp    # SSH
sudo ufw allow 80/tcp    # HTTP
sudo ufw allow 443/tcp   # HTTPS
sudo ufw enable
```

### Backup Strategy

**Database backup:**
```bash
mysqldump -u choirapp -p choir_voice_player > backup-$(date +%Y%m%d).sql
```

**Automate backups with cron:**
```bash
crontab -e
```

Add:
```
0 2 * * * mysqldump -u choirapp -p<SECURE_PASSWORD> choir_voice_player > /backups/db-$(date +\%Y\%m\%d).sql
```

## Troubleshooting

### Services won't start

Check logs:
```bash
pm2 logs
```

Check if ports are in use:
```bash
netstat -tulpn | grep -E '3000|8001'
```

### Database connection errors

Verify MySQL is running:
```bash
systemctl status mysql
```

Test connection:
```bash
mysql -u choirapp -p choir_voice_player
```

### Python service errors

Check Python version:
```bash
python3.11 --version
```

Verify dependencies:
```bash
pip3 list | grep -E 'oemer|music21|fastapi'
```

### Nginx errors

Check configuration:
```bash
nginx -t
```

View error logs:
```bash
tail -f /var/log/nginx/choir-voice-player-error.log
```

### SSL certificate issues

Renew certificate:
```bash
certbot renew --dry-run
```

### Out of memory

Increase swap space:
```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

## Performance Optimization

### Enable Gzip compression

Edit Nginx config:
```bash
nano /etc/nginx/nginx.conf
```

Ensure these lines are uncommented:
```nginx
gzip on;
gzip_vary on;
gzip_types text/plain text/css application/json application/javascript text/xml application/xml;
```

### PM2 Cluster Mode

For better performance, edit `ecosystem.config.js`:
```javascript
instances: 'max',
exec_mode: 'cluster'
```

Then restart:
```bash
pm2 reload all
```

## Security Recommendations

1. **Change default SSH port**
2. **Disable root login** (create sudo user)
3. **Set up fail2ban** for brute-force protection
4. **Regular security updates**: `apt-get update && apt-get upgrade`
5. **Use strong passwords** for database and system users
6. **Enable firewall** (ufw)
7. **Regular backups** of database and files
8. **Monitor logs** for suspicious activity

## Support

If you encounter issues:

1. Check the logs: `pm2 logs`
2. Verify all services are running: `pm2 status`
3. Check system resources: `htop`
4. Review Nginx logs: `/var/log/nginx/`
5. Test database connection
6. Verify S3 credentials

## Maintenance Schedule

- **Daily**: Monitor logs and system resources
- **Weekly**: Check for security updates
- **Monthly**: Review and rotate logs, backup database
- **Quarterly**: Update dependencies, review performance

---

**Deployment complete!** Your Choir Voice Player should now be accessible at https://your-domain.com

