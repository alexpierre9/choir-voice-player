#!/bin/sh
# Entrypoint script for the Docker container.
#
# Starts both the Node.js server and the Python FastAPI service.
# If either process exits (crash or graceful stop), the other is killed
# and the container exits with a non-zero code so Docker (or the orchestrator)
# knows to restart it.
#
# Note: POSIX sh is used (not bash) because node:22-slim uses dash as /bin/sh.

set -e

# Forward SIGTERM / SIGINT to child processes so they can shut down cleanly.
cleanup() {
    echo "[entrypoint] Signal received — stopping services..."
    kill "$NODE_PID" "$PYTHON_PID" 2>/dev/null || true
    wait "$NODE_PID" "$PYTHON_PID" 2>/dev/null || true
    exit 0
}
trap cleanup INT TERM

echo "[entrypoint] Starting Node.js server..."
node dist/index.js &
NODE_PID=$!

echo "[entrypoint] Starting Python FastAPI service..."
python3 python_service/music_processor.py &
PYTHON_PID=$!

echo "[entrypoint] Both services started (Node PID=$NODE_PID, Python PID=$PYTHON_PID)"

# Poll until either process exits, then clean up and propagate failure.
while true; do
    # Check Node process
    if ! kill -0 "$NODE_PID" 2>/dev/null; then
        echo "[entrypoint] Node.js process (PID=$NODE_PID) exited — stopping Python service..."
        kill "$PYTHON_PID" 2>/dev/null || true
        wait "$PYTHON_PID" 2>/dev/null || true
        exit 1
    fi

    # Check Python process
    if ! kill -0 "$PYTHON_PID" 2>/dev/null; then
        echo "[entrypoint] Python process (PID=$PYTHON_PID) exited — stopping Node.js server..."
        kill "$NODE_PID" 2>/dev/null || true
        wait "$NODE_PID" 2>/dev/null || true
        exit 1
    fi

    sleep 5
done
