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

RUN pnpm build

# Stage 2: Combined Node.js + Python backend
FROM node:22-slim AS backend

WORKDIR /app

# Install Python 3 and system dependencies (poppler-utils for pdf2image)
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    poppler-utils \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies
COPY python_service/requirements.txt ./python_service/requirements.txt
RUN pip3 install --no-cache-dir -r python_service/requirements.txt --break-system-packages

# Install Node dependencies
COPY package.json pnpm-lock.yaml ./
RUN npm install -g pnpm
RUN pnpm install --prod

# Copy backend source
COPY ./server ./server
COPY ./shared ./shared
COPY ./drizzle ./drizzle
COPY ./drizzle.config.ts ./
COPY ./tsconfig.json ./

# Copy Python service
COPY ./python_service ./python_service

# Copy built frontend assets
COPY --from=frontend-builder /app/dist ./dist

EXPOSE 3000
EXPOSE 8001

# Start Node.js server and Python service concurrently
CMD ["sh", "-c", "node dist/index.js & python3 python_service/music_processor.py && wait"]
