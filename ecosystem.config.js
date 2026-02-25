module.exports = {
  apps: [
    {
      name: 'choir-satb',
      script: 'dist/index.js',
      // P-08: explicit cwd ensures dotenv finds .env on PM2 resurrect after reboot
      cwd: '/var/www/choir-voice-player',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
        PYTHON_SERVICE_URL: 'http://localhost:8001'
      }
    },
    {
      name: 'choir-omr-service',
      script: 'python_service/music_processor.py',
      // B-11: setup:python creates the venv at python_service/.venv (leading dot)
      interpreter: 'python_service/.venv/bin/python',
      // P-08: explicit cwd ensures the service finds its config files on resurrect
      cwd: '/var/www/choir-voice-player',
      instances: 1,
      autorestart: true,
      watch: false,
      env: {
        PYTHON_SERVICE_PORT: 8001,
        GEMINI_API_KEY: process.env.GEMINI_API_KEY,
        // P-12: forward the shared secret so the Python service enforces token auth
        INTERNAL_SERVICE_TOKEN: process.env.INTERNAL_SERVICE_TOKEN
      }
    }
  ]
};
