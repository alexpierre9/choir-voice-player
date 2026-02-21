# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm install          # Install dependencies
pnpm dev              # Start dev server (tsx watch, hot reload)
pnpm build            # Build frontend (Vite) + backend (esbuild) to dist/
pnpm start            # Run production server
pnpm check            # TypeScript type checking (tsc --noEmit)
pnpm format           # Format code with Prettier
pnpm test             # Run tests with Vitest
pnpm db:push          # Generate and apply Drizzle migrations
```

## Architecture Overview

This is a full-stack monorepo for a choir voice separation app: users upload sheet music (PDF or MusicXML), the app extracts SATB voice parts, and plays each voice via MIDI synthesis in the browser.

### Layers

**Client** (`/client/`) — React 19 + Vite, Tailwind CSS 4, shadcn/ui, Wouter routing, React Query + tRPC hooks, Tone.js for MIDI playback.

**Server** (`/server/`) — Express + tRPC 11 (type-safe RPC), Drizzle ORM with MySQL/TiDB, JWT session cookies, dual storage adapters (cloud or local filesystem), rate limiting.

**Python Service** (`/python_service/`) — FastAPI on port 8001. Handles the music processing pipeline: Gemini Vision for PDF→MusicXML OMR, music21 for MusicXML parsing and voice detection, MIDI file generation per voice part.

**Shared** (`/shared/`) — Types (from Drizzle schema), constants, and error definitions shared between client and server.

### File Processing Pipeline

```
1. Client uploads file (base64) → tRPC upload procedure
2. Server stores original file (local FS or Forge cloud), creates DB record (status='processing')
3. Async calls to Python service:
   - POST /api/process-pdf  → Gemini OMR → MusicXML (PDF only)
   - POST /api/process-musicxml → music21 analysis → voice detection
   - POST /api/generate-midi → separate MIDI file per SATB voice
4. DB updated with analysisResult, voiceAssignments, midiFileKeys (status='ready')
5. Client polls status; on ready, loads MIDIs via Tone.js for playback
```

### API (tRPC)

All client-server communication is through tRPC. The router in `server/routers.ts` exposes:
- `auth.me`, `auth.logout`
- `sheetMusic.upload`, `.get`, `.list`, `.updateVoiceAssignments`, `.getMidiUrl`, `.delete`

Protected procedures enforce authentication via `protectedProcedure` middleware. Rate limits: 100 req/15min general, 10 uploads/15min.

### Storage

Two adapters implement the same interface:
- `server/storage.ts` — Manus Forge cloud API (production, requires `BUILT_IN_FORGE_API_URL` / `BUILT_IN_FORGE_API_KEY`)
- `server/storage-local.ts` — Local filesystem (VPS, files served at `/files/`, configurable via `LOCAL_STORAGE_DIR`)

### Database

Drizzle ORM with MySQL2. Two tables: `users` and `sheet_music`. The `sheet_music` table stores file keys (S3-style paths), processing status, and JSON blobs for analysis results, voice assignments, and MIDI file keys.

### Path Aliases

- `@/*` → `client/src/*`
- `@shared/*` → `shared/*`

## Key Environment Variables

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | MySQL connection string |
| `JWT_SECRET` | Session cookie signing |
| `GEMINI_API_KEY` | Google AI for PDF OMR |
| `VITE_APP_ID` | OAuth app ID |
| `OAUTH_SERVER_URL` | OAuth backend endpoint |
| `VITE_OAUTH_PORTAL_URL` | OAuth login portal |
| `BUILT_IN_FORGE_API_URL` | Cloud storage API |
| `BUILT_IN_FORGE_API_KEY` | Cloud storage API key |
| `LOCAL_STORAGE_DIR` | Local FS storage path (VPS) |
| `PYTHON_SERVICE_URL` | Python service URL (default: `http://localhost:8001`) |

## Deployment

Docker Compose runs the Node server (port 3000) + MySQL 8.0. The `/deploy/` directory contains setup scripts for VPS deployments (nginx, database config). See `deploy/DEPLOYMENT_GUIDE.md` for details.
