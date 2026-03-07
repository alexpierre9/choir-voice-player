# Multi-stage build for the Choir Voice Player

# Stage 1: Build frontend
FROM node:22-alpine AS frontend-builder

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN npm install -g pnpm
RUN pnpm install --frozen-lockfile

COPY ./client ./client
COPY ./shared ./shared
COPY ./vite.config.ts ./
COPY ./tsconfig.json ./

RUN pnpm build

# Stage 2: Build backend (server + migrate script)
FROM node:22-alpine AS backend-builder

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN npm install -g pnpm
RUN pnpm install --frozen-lockfile

COPY ./server ./server
COPY ./shared ./shared
COPY ./scripts ./scripts
COPY ./drizzle ./drizzle
COPY ./drizzle.config.ts ./
COPY ./tsconfig.json ./

RUN pnpm esbuild server/_core/index.ts --platform=node --packages=external --bundle --format=esm --outfile=dist/index.js
RUN pnpm esbuild scripts/migrate.ts --platform=node --packages=external --bundle --format=esm --outfile=dist/migrate.js

# Stage 3: Combined Node.js + Python backend
FROM node:22-slim AS backend

WORKDIR /app

# Install Python 3. No system-level OMR dependencies needed —
# PDF rendering is handled by PyMuPDF (bundled, no external binaries).
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies
COPY python_service/requirements.txt ./python_service/requirements.txt
RUN pip3 install --no-cache-dir -r python_service/requirements.txt --break-system-packages

# Install Node dependencies (prod only — source is pre-compiled)
COPY package.json pnpm-lock.yaml ./
RUN npm install -g pnpm
RUN pnpm install --frozen-lockfile --prod

# Copy compiled server + migrate bundles from backend-builder
COPY --from=backend-builder /app/dist ./dist

# Copy migration SQL files (needed at runtime by migrate.js)
COPY --from=backend-builder /app/drizzle ./drizzle

# Copy built frontend assets (into dist/, alongside server bundle)
COPY --from=frontend-builder /app/dist ./dist

# Copy Python service
COPY ./python_service ./python_service

EXPOSE 3000
EXPOSE 8001

# Copy and enable the entrypoint script that supervises both processes.
# If either the Node server or the Python service crashes, the other is stopped
# and the container exits — allowing Docker (or the orchestrator) to restart it.
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

CMD ["/docker-entrypoint.sh"]
