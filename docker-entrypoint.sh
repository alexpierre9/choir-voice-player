#!/bin/sh
# Entrypoint script for the Docker container.
#
# Starts the Node.js server first, waits up to 30s for it to be healthy,
# then starts the Python FastAPI service.  If either process exits (crash or
# graceful stop), the other is killed and the container exits with a non-zero
# code so Docker (or the orchestrator) knows to restart it.
#
# Note: POSIX sh is used (not bash) because node:22-slim uses dash as /bin/sh.

set -e

# ---------------------------------------------------------------------------
# Signal handling — forward SIGTERM / SIGINT to child processes.
# ---------------------------------------------------------------------------
cleanup() {
    echo "[entrypoint $(date -u +%H:%M:%S)] Signal received — stopping services..."
    kill "$NODE_PID" "$PYTHON_PID" 2>/dev/null || true
    wait "$NODE_PID" "$PYTHON_PID" 2>/dev/null || true
    exit 0
}
trap cleanup INT TERM

# ---------------------------------------------------------------------------
# Auto-generate INTERNAL_SERVICE_TOKEN if not provided.
# This ensures the Node <-> Python channel is always authenticated even when
# the operator forgets to set the variable.  The token is ephemeral (per
# container instance), which is fine for single-container deployments.
# ---------------------------------------------------------------------------
if [ -z "$INTERNAL_SERVICE_TOKEN" ]; then
    export INTERNAL_SERVICE_TOKEN=$(openssl rand -hex 32)
    echo "[entrypoint $(date -u +%H:%M:%S)] Generated INTERNAL_SERVICE_TOKEN for this container instance"
fi

# ---------------------------------------------------------------------------
# Database migrations
# ---------------------------------------------------------------------------
echo "[entrypoint $(date -u +%H:%M:%S)] Running database migrations..."
node /app/dist/migrate.js
echo "[entrypoint $(date -u +%H:%M:%S)] Migrations done."

# ---------------------------------------------------------------------------
# Start Node.js server first
# ---------------------------------------------------------------------------
echo "[entrypoint $(date -u +%H:%M:%S)] Starting Node.js server..."
node dist/index.js &
NODE_PID=$!

# Wait up to 30 seconds for Node to be ready (poll /health every 2 seconds)
echo "[entrypoint $(date -u +%H:%M:%S)] Waiting for Node.js to become healthy..."
NODE_READY=0
ATTEMPTS=0
MAX_ATTEMPTS=15  # 15 × 2s = 30s

while [ $ATTEMPTS -lt $MAX_ATTEMPTS ]; do
    # Check that the process is still alive before polling HTTP
    if ! kill -0 "$NODE_PID" 2>/dev/null; then
        echo "[entrypoint $(date -u +%H:%M:%S)] Node.js process (PID=$NODE_PID) exited during startup — aborting."
        exit 1
    fi

    if wget -q -O /dev/null http://localhost:3000/health 2>/dev/null; then
        NODE_READY=1
        break
    fi

    ATTEMPTS=$((ATTEMPTS + 1))
    sleep 2
done

if [ $NODE_READY -eq 0 ]; then
    echo "[entrypoint $(date -u +%H:%M:%S)] Node.js did not become healthy within 30s — aborting."
    kill "$NODE_PID" 2>/dev/null || true
    exit 1
fi

echo "[entrypoint $(date -u +%H:%M:%S)] Node.js is healthy (PID=$NODE_PID)."

# ---------------------------------------------------------------------------
# Start Python service AFTER Node is healthy
# ---------------------------------------------------------------------------
echo "[entrypoint $(date -u +%H:%M:%S)] Starting Python FastAPI service..."
python3 python_service/music_processor.py &
PYTHON_PID=$!

echo "[entrypoint $(date -u +%H:%M:%S)] Both services started (Node PID=$NODE_PID, Python PID=$PYTHON_PID)"

# ---------------------------------------------------------------------------
# Crash detection loop — poll until either process exits, then clean up.
# ---------------------------------------------------------------------------
while true; do
    # Check Node process
    if ! kill -0 "$NODE_PID" 2>/dev/null; then
        echo "[entrypoint $(date -u +%H:%M:%S)] Node.js process (PID=$NODE_PID) exited — stopping Python service..."
        kill "$PYTHON_PID" 2>/dev/null || true
        wait "$PYTHON_PID" 2>/dev/null || true
        exit 1
    fi

    # Check Python process
    if ! kill -0 "$PYTHON_PID" 2>/dev/null; then
        echo "[entrypoint $(date -u +%H:%M:%S)] Python process (PID=$PYTHON_PID) exited — stopping Node.js server..."
        kill "$NODE_PID" 2>/dev/null || true
        wait "$NODE_PID" 2>/dev/null || true
        exit 1
    fi

    sleep 5
done
