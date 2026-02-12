# Multi-stage build for the Choir Voice Player
FROM node:22-alpine AS frontend-builder

WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml ./

# Install pnpm and dependencies
RUN npm install -g pnpm
RUN pnpm install

# Copy frontend source
COPY ./client ./client
COPY ./shared ./shared
COPY ./vite.config.ts ./
COPY ./tsconfig.json ./

# Build the frontend
RUN pnpm build

# Python service stage
FROM python:3.11-slim AS python-service

WORKDIR /app

# Install system dependencies required for pdf2image
RUN apt-get update && apt-get install -y \
    poppler-utils \
    && rm -rf /var/lib/apt/lists/*

# Copy Python dependencies
COPY requirements.txt .

# Install Python dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Copy Python service
COPY ./python_service ./python_service

# Node.js backend stage
FROM node:22-alpine AS backend

WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml ./

# Install pnpm and dependencies
RUN npm install -g pnpm
RUN pnpm install

# Copy backend source
COPY ./server ./server
COPY ./shared ./shared
COPY ./drizzle ./drizzle
COPY ./drizzle.config.ts ./
COPY ./tsconfig.json ./

# Copy built frontend assets
COPY --from=frontend-builder /app/dist ./dist

# Expose ports
EXPOSE 3000
EXPOSE 8001

# Start both services
CMD ["sh", "-c", "node dist/index.js & python3 python_service/music_processor.py && wait"]