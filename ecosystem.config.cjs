module.exports = {
  apps: [
    {
      name: 'choir-app',
      script: './dist/index.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
        PORT: 3000
      }
    },
    {
      name: 'choir-python',
      script: 'venv/bin/uvicorn',
      args: 'music_processor:app --host 0.0.0.0 --port 8001',
      cwd: './python_service',
      interpreter: 'python3',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        // Inherits environment, but you can override
        // e.g., PYTHON_SERVICE_PORT: 8001
      }
    }
  ]
};
