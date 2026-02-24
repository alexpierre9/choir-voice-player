module.exports = {
  apps: [
    {
      name: 'choir-satb',
      script: 'dist/index.js',
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
      interpreter: 'python_service/.venv/bin/python',
      instances: 1,
      autorestart: true,
      watch: false,
      env: {
        PYTHON_SERVICE_PORT: 8001,
        GEMINI_API_KEY: process.env.GEMINI_API_KEY
      }
    }
  ]
};
