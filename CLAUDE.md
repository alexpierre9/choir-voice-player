# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Prerequisites

Node.js 22+, pnpm 10+, Python 3.11+, PostgreSQL 16 (via platform Docker network).

## Commands

```bash
pnpm install          # Install dependencies
pnpm dev              # Start dev server (tsx watch, hot reload)
pnpm dev:python       # Start Python FastAPI service on port 8001
pnpm setup:python     # Create Python venv and install dependencies
pnpm build            # Build frontend (Vite) + backend (esbuild) to dist/
pnpm start            # Run production server
pnpm check            # TypeScript type checking (tsc --noEmit)
pnpm lint             # ESLint (typescript-eslint + react-hooks)
pnpm format           # Format code with Prettier
pnpm test             # Run tests with Vitest
pnpm test -- path     # Run a single test file
pnpm db:push          # Generate and apply Drizzle migrations
```

## Architecture Overview

Full-stack monorepo for a choir voice separation app: users upload sheet music (PDF or MusicXML), the app extracts SATB voice parts, and plays each voice via MIDI synthesis in the browser.

### Layers

**Client** (`/client/`) — React 19 + Vite 7, Tailwind CSS 4, shadcn/ui, Wouter routing, React Query + tRPC hooks, Tone.js for MIDI playback.

**Server** (`/server/`) — Express + tRPC 11 (type-safe RPC), Drizzle ORM with postgres-js (lazy connection), JWT session cookies (single-owner passphrase auth), dual storage adapters (cloud or local filesystem), rate limiting.

**Python Service** (`/python_service/`) — FastAPI on port 8001. Handles the music processing pipeline: Gemini Vision for PDF→MusicXML OMR, music21 for MusicXML parsing and voice detection, MIDI file generation per voice part.

**Shared** (`/shared/`) — Types (re-exported from Drizzle schema), constants (`COOKIE_NAME`, `UNAUTHED_ERR_MSG`), and `HttpError` constructors shared between client and server.

### Server Core (`server/_core/`)

- `index.ts` — Express setup, request-ID middleware, access logging, rate limiting, body parser (100MB limit for base64 files), Vite dev mode integration
- `trpc.ts` — tRPC init with SuperJSON transformer. Defines `publicProcedure`, `protectedProcedure`, `adminProcedure`
- `context.ts` — tRPC context factory, authenticates requests via SDK
- `sdk.ts` — JWT (HS256, jose) session management, timing-safe passphrase comparison
- `env.ts` — Centralized environment variable loading
- `cookies.ts` — Session cookie config (httpOnly, sameSite varies by HTTPS)
- `logger.ts` — Structured logger (JSON in production, human-readable in dev). Use `logger.child({ req_id })` for request-scoped logging.

### Authentication

Single-owner passphrase auth. Key patterns:
- Login compares passphrase against `AUTH_PASSPHRASE` env var using `timingSafeEqual` (prevents timing attacks)
- Sessions are JWT tokens stored in `app_session_id` cookies (1-year expiry)
- The single user row has `id = "owner"` and is upserted on first login
- `SafeUser` type is the full user row (no password hash — there is none)

### API (tRPC)

All client-server communication is through tRPC. The router in `server/routers.ts` exposes:
- `auth.me`, `auth.login`, `auth.logout`
- `sheetMusic.upload`, `.get`, `.list`, `.rename`, `.updateVoiceAssignments`, `.getMidiUrl`, `.delete`, `.deleteMany`, `.retry`
- `settings.getGeminiConfig`, `.updateGeminiConfig`, `.testGeminiConnection`

Protected procedures enforce authentication via `protectedProcedure` middleware. Rate limits: 100 req/15min general, 10 uploads/15min (skipped in dev).

### Client Key Patterns

- tRPC client configured in `client/src/lib/trpc.ts` with SuperJSON and credentials: "include"
- Auto-redirect to login on `UNAUTHED_ERR_MSG` (error code 10001) via QueryClient's onError
- `getLoginUrl()` helper preserves post-login redirect via `?redirect=` query param
- `APP_TITLE` / `APP_LOGO` configurable via `VITE_APP_TITLE` / `VITE_APP_LOGO` env vars

### File Processing Pipeline

```
1. Client uploads file (base64, max 50MB) → tRPC upload procedure
2. Server stores original file (local FS or Forge cloud), creates DB record (status='processing')
3. Async background calls to Python service:
   - POST /api/process-pdf  → Gemini OMR → MusicXML (PDF only)
   - POST /api/process-musicxml → music21 analysis → voice detection
   - POST /api/generate-midi → separate MIDI file per SATB voice
4. DB updated with analysisResult, voiceAssignments, midiFileKeys (status='ready')
5. Client receives real-time progress via SSE (GET /api/sse/sheet/:id), falls back to 3s polling
6. On ready, loads MIDIs via Tone.js for playback
```

### Server-Sent Events (SSE)

`server/sse.ts` provides real-time processing updates:
- `GET /api/sse/sheet/:id` — authenticated SSE endpoint (reads JWT from cookie)
- `emitProcessingEvent(sheetId, event, data)` — emits events from `processSheetMusicAsync`
- Events: `processing_step` (step name), `status_changed` (ready/error)
- In-memory `EventEmitter` keyed by sheetId; 30s heartbeat; auto-cleanup on disconnect
- Client subscribes via `EventSource` in SheetDetail while status is "processing"

### Storage

Two adapters both implement `StorageAdapter` (defined in `server/storage-interface.ts`):
- `server/storage-local.ts` — Local filesystem (active default, files served at `/files/`, configurable via `LOCAL_STORAGE_DIR`). Includes directory traversal protection.
- `server/storage.ts` — Forge cloud API (inactive, requires `BUILT_IN_FORGE_API_URL` / `BUILT_IN_FORGE_API_KEY`).

`server/storage-active.ts` is the single import point used by the rest of the server. To switch adapters, change the re-export in that file.

### Database

Drizzle ORM with postgres-js (lazy connection). Three tables: `users`, `sheet_music`, and `app_settings`. Schema in `drizzle/schema.ts`, migrations in `drizzle/`. The `sheet_music` table stores file keys (S3-style paths), processing status, and JSON blobs for analysis results, voice assignments, and MIDI file keys. The `app_settings` table stores key-value pairs for server config (e.g., Gemini API key, model name).

### Path Aliases

- `@/*` → `client/src/*`
- `@shared/*` → `shared/*`

### Testing

Vitest configured for server-side only (`server/**/*.test.ts`, `server/**/*.spec.ts`). Run with `pnpm test`.

## Key Environment Variables

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `JWT_SECRET` | Yes | Session cookie signing key |
| `AUTH_PASSPHRASE` | Yes | Single-owner login passphrase |
| `GEMINI_API_KEY` | For AI refinement | Google Gemini API (optional — refines Audiveris OMR output) |
| `AUDIVERIS_CMD` | No | Path to Audiveris CLI (default `audiveris`) |
| `INTERNAL_SERVICE_TOKEN` | Recommended in prod | Shared secret between Node and Python service |
| `OWNER_OPEN_ID` | No | User ID designated as admin |
| `LOCAL_STORAGE_DIR` | No | Local FS storage path (default `/var/lib/choir-files`) |
| `PUBLIC_URL_BASE` | No | Public file serving base (default `/files/`) |
| `PYTHON_SERVICE_URL` | No | Python service URL (default `http://localhost:8001`) |
| `PORT` | No | HTTP port (default `3000`) |
| `VITE_APP_TITLE` | No | App display name (default "Choir Voice Player") |
| `VITE_APP_LOGO` | No | App logo URL |
| `BUILT_IN_FORGE_API_URL` | No | Cloud storage API (inactive adapter) |
| `BUILT_IN_FORGE_API_KEY` | No | Cloud storage API key (inactive adapter) |

## Deployment

Docker Compose runs the Node server (port 3000) + Python OMR service in the same container network. The `/deploy/` directory contains setup scripts for VPS deployments (nginx, database config). See `deploy/DEPLOYMENT_GUIDE.md` for details.
