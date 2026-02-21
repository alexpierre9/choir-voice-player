# Quick Start - Deploy in 10 Minutes

Follow these commands to deploy Choir Voice Player on your Hostinger VPS.

## Prerequisites Checklist

- [ ] Hostinger VPS with Ubuntu 20.04/22.04 (2GB+ RAM)
- [ ] Root/sudo access
- [ ] Domain name pointed to VPS IP
- [ ] S3 storage account ready (AWS, Backblaze, or DigitalOcean)

## Deployment Commands

### 1. Connect to VPS

```bash
ssh root@YOUR_VPS_IP
```

### 2. Download and Run Setup

```bash
# Clone repository
cd /tmp
git clone https://github.com/alexpierre9/choir-voice-player.git
cd choir-voice-player/deploy

# Make scripts executable
chmod +x *.sh

# Install system dependencies (5-10 minutes)
sudo ./setup.sh
```

### 3. Configure Database

```bash
sudo ./configure-database.sh
```

**Save the database URL shown at the end!**

### 4. Generate JWT Secret

```bash
openssl rand -base64 32
```

**Save this secret!**

### 5. Create Environment File

```bash
mkdir -p /var/www/choir-voice-player
cp /tmp/choir-voice-player/deploy/.env.template /var/www/choir-voice-player/.env
nano /var/www/choir-voice-player/.env
```

**Edit these values:**
- `DATABASE_URL` - from step 3
- `JWT_SECRET` - from step 4
- `AWS_ACCESS_KEY_ID` - your S3 access key
- `AWS_SECRET_ACCESS_KEY` - your S3 secret key
- `AWS_BUCKET_NAME` - your S3 bucket name
- `AWS_ENDPOINT` - your S3 endpoint URL
- `DOMAIN` - your domain name

Save (Ctrl+X, Y, Enter)

### 6. Deploy Application

```bash
cd /tmp/choir-voice-player/deploy
sudo ./deploy-app.sh
```

### 7. Enable SSL

```bash
sudo certbot --nginx -d your-domain.com
```

### 8. Done! 🎉

Visit: `https://your-domain.com`

## Verify Deployment

```bash
# Check services
pm2 status

# View logs
pm2 logs

# Test locally
curl http://localhost:3000
```

## Common Issues

**Services not starting?**
```bash
pm2 logs
```

**Database connection error?**
```bash
mysql -u choirapp -p choir_voice_player
```

**Nginx error?**
```bash
nginx -t
tail -f /var/log/nginx/error.log
```

## Need Help?

Read the full guide: `DEPLOYMENT_GUIDE.md`

## Update Application

```bash
cd /var/www/choir-voice-player
git pull
pnpm install
pnpm run build
pm2 restart all
```

---

**Total time: ~10-15 minutes** (excluding DNS propagation)

