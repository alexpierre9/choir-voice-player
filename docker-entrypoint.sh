#!/bin/sh
set -e

# Start Python service in background
python3 /app/python_service/music_processor.py &
PYTHON_PID=$!

# Start Node.js app in background
node /app/dist/index.js &
NODE_PID=$!

# Wait for either to exit, then kill the other
wait -n $PYTHON_PID $NODE_PID
EXIT_CODE=$?

kill $PYTHON_PID $NODE_PID 2>/dev/null || true
exit $EXIT_CODE
