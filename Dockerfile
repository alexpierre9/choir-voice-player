# Multi-stage build for the Choir Voice Player

# Stage 1: Build frontend
FROM node:22-alpine AS frontend-builder

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN npm install -g pnpm
RUN pnpm install

COPY ./client ./client
COPY ./shared ./shared
COPY ./vite.config.ts ./
COPY ./tsconfig.json ./

RUN pnpm vite build

# Stage 2: Build backend deps
FROM node:22-alpine AS backend

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN npm install -g pnpm
RUN pnpm install --prod

COPY ./server ./server
COPY ./shared ./shared
COPY ./drizzle ./drizzle
COPY ./drizzle.config.ts ./
COPY ./tsconfig.json ./

# Build server bundle
RUN pnpm esbuild server/_core/index.ts --platform=node --packages=external --bundle --format=esm --outdir=dist

# Stage 3: Final production image
FROM node:22-slim AS production

WORKDIR /app

# Install Python 3 + poppler for pdf2image
RUN apt-get update && apt-get install -y \
    python3 python3-pip python3-venv poppler-utils \
    && rm -rf /var/lib/apt/lists/*

# Install Python deps
COPY python_service/requirements.txt /app/python_service/
RUN python3 -m pip install --no-cache-dir --break-system-packages -r /app/python_service/requirements.txt

# Copy Python service
COPY python_service/ /app/python_service/

# Copy Node.js app
COPY --from=backend /app/node_modules /app/node_modules
COPY --from=backend /app/dist/index.js /app/dist/index.js
COPY --from=backend /app/package.json /app/

# Copy built frontend assets
COPY --from=frontend-builder /app/dist/public /app/dist/public

# Volumes for persistent file storage
VOLUME ["/var/lib/choir-files"]

EXPOSE 3000 8001

COPY docker-entrypoint.sh /app/
RUN chmod +x /app/docker-entrypoint.sh
CMD ["/app/docker-entrypoint.sh"]
