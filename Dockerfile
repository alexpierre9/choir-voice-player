# Multi-stage build for the Choir Voice Player

# Stage 1: Build frontend
FROM node:22-alpine AS frontend-builder

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
COPY patches ./patches
RUN npm install -g pnpm
RUN pnpm install --frozen-lockfile

COPY ./client ./client
COPY ./shared ./shared
COPY ./vite.config.ts ./
COPY ./tsconfig.json ./

RUN pnpm vite build

# Stage 2: Build backend (server + migrate script)
FROM node:22-alpine AS backend-builder

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
COPY patches ./patches
RUN npm install -g pnpm
RUN pnpm install --frozen-lockfile

COPY ./server ./server
COPY ./shared ./shared
COPY ./scripts ./scripts
COPY ./drizzle ./drizzle
COPY ./drizzle.config.ts ./
COPY ./tsconfig.json ./
COPY ./vite.config.ts ./

RUN pnpm esbuild server/_core/index.ts --platform=node --packages=external --bundle --format=esm --outfile=dist/index.js
RUN pnpm esbuild scripts/migrate.ts --platform=node --packages=external --bundle --format=esm --outfile=dist/migrate.js

# Stage 3: Combined Node.js + Python backend
FROM node:22-slim AS backend

WORKDIR /app

# Install Python 3, fonts (required by Java AWT/Audiveris), and helper tools.
# Java 21 for Audiveris is installed via Eclipse Temurin (Adoptium) below —
# openjdk-21 is not in Debian bookworm arm64 repos.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    wget \
    dpkg \
    tar \
    fontconfig \
    fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

# Install Eclipse Temurin 21 JRE (arm64 + amd64 supported via official tarballs).
# Audiveris 5.6.1 requires Java 21 (class file version 65).
ENV JAVA_HOME=/opt/java/temurin-21
RUN ARCH=$(dpkg --print-architecture) && \
    if [ "$ARCH" = "arm64" ]; then JDK_ARCH="aarch64"; else JDK_ARCH="x64"; fi && \
    JRE_URL="https://api.adoptium.net/v3/binary/latest/21/ga/linux/${JDK_ARCH}/jre/hotspot/normal/eclipse" && \
    mkdir -p ${JAVA_HOME} && \
    wget -qO- "$JRE_URL" | tar -xz -C ${JAVA_HOME} --strip-components=1
ENV PATH="${JAVA_HOME}/bin:${PATH}"

# Install Audiveris 5.6.1 by extracting JARs from the .deb (works on arm64 + amd64 —
# the .deb bundles platform-specific leptonica/tesseract JARs for both arches).
ENV AUDIVERIS_VERSION=5.6.1
ENV AUDIVERIS_DIR=/opt/audiveris
RUN wget -q "https://github.com/Audiveris/audiveris/releases/download/${AUDIVERIS_VERSION}/Audiveris-${AUDIVERIS_VERSION}-ubuntu24.04-x86_64.deb" \
        -O /tmp/audiveris.deb && \
    mkdir -p ${AUDIVERIS_DIR} && \
    dpkg-deb --extract /tmp/audiveris.deb /tmp/audir && \
    cp -r /tmp/audir/opt/audiveris/lib/app ${AUDIVERIS_DIR}/lib && \
    rm -rf /tmp/audiveris.deb /tmp/audir

# Create a shell wrapper that invokes Audiveris via java (works on any JVM arch).
# Build the classpath from Audiveris.cfg app.classpath entries.
RUN APPDIR=${AUDIVERIS_DIR}/lib && \
    CFG=${APPDIR}/Audiveris.cfg && \
    CP=$(grep '^app.classpath=' "$CFG" | sed "s|app.classpath=\$APPDIR|${APPDIR}|g" | paste -sd ':') && \
    JAVA_OPTS=$(grep '^java-options=' "$CFG" | sed 's/java-options=//' | tr '\n' ' ') && \
    printf '#!/bin/sh\nexec java %s -cp "%s" Audiveris "$@"\n' "$JAVA_OPTS" "$CP" > /usr/local/bin/audiveris && \
    chmod +x /usr/local/bin/audiveris

ENV AUDIVERIS_CMD=/usr/local/bin/audiveris

# Install Python dependencies
COPY python_service/requirements.txt ./python_service/requirements.txt
RUN pip3 install --no-cache-dir -r python_service/requirements.txt --break-system-packages

# Install Node dependencies (all deps needed — vite is a runtime import in vite.ts)
COPY package.json pnpm-lock.yaml ./
COPY patches ./patches
RUN npm install -g pnpm
RUN pnpm install --frozen-lockfile

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
