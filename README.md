# Choir Voice Player

A single-owner web app for choir directors. Upload a PDF or MusicXML score, let the app detect the four SATB voice parts using AI, and play each voice independently in the browser via MIDI synthesis.

## What it does

1. **Upload** a PDF or MusicXML sheet music file (up to 50 MB).
2. **OCR + Analysis** — PDF files are processed by Gemini Vision (OMR); MusicXML files are parsed directly. The Python service detects Soprano, Alto, Tenor, and Bass parts using part names, clef, stem direction, and pitch-range heuristics.
3. **MIDI generation** — one MIDI file is produced per voice part.
4. **Playback** — the React frontend synthesises each voice in the browser via Tone.js. Mute or solo any part independently.

---

## Prerequisites

| Tool | Version |
|---|---|
| Node.js | 22+ |
| pnpm | 10+ |
| Python | 3.11+ |
| MySQL | 8.0+ (or Docker) |

You also need a **Google Gemini API key** for PDF optical music recognition. MusicXML uploads work without it.

---

## Local development

### 1. Clone and install Node dependencies

```bash
git clone <repo-url> choir-voice-player
cd choir-voice-player
pnpm install
```

### 2. Set up environment variables

```bash
cp .env.example .env
```

Edit `.env`:

```ini
DATABASE_URL="mysql://root:rootpassword@localhost:3306/choir_voice_player"
JWT_SECRET=""             # openssl rand -hex 32
AUTH_PASSPHRASE=""        # any passphrase you choose
GEMINI_API_KEY=""         # from Google AI Studio (https://aistudio.google.com/)
INTERNAL_SERVICE_TOKEN="" # openssl rand -hex 32 (optional in dev)
```

### 3. Start MySQL

Use Docker Compose for the database only:

```bash
docker compose up db -d
```

Or run MySQL locally and create the database:

```bash
mysql -u root -p -e "CREATE DATABASE choir_voice_player;"
```

### 4. Run database migrations

```bash
pnpm db:push
```

### 5. Set up the Python service

```bash
pnpm setup:python          # creates python_service/.venv and installs dependencies
```

### 6. Start everything

Open two terminals:

```bash
# Terminal 1 — Node server + React dev server (hot reload)
pnpm dev

# Terminal 2 — Python FastAPI service
pnpm dev:python
```

Visit [http://localhost:3000](http://localhost:3000) and log in with the passphrase you set in `AUTH_PASSPHRASE`.

---

## Commands

```bash
pnpm dev              # Start Node server with hot reload (tsx watch)
pnpm dev:python       # Start Python FastAPI service on port 8001
pnpm setup:python     # Create Python venv and install dependencies
pnpm build            # Build frontend (Vite) + backend (esbuild) to dist/
pnpm start            # Run production Node server
pnpm check            # TypeScript type checking (tsc --noEmit)
pnpm format           # Format all files with Prettier
pnpm test             # Run Vitest tests
pnpm db:push          # Generate and apply Drizzle migrations
```

---

## Architecture

```
Browser (React + Tone.js)
     ↕ tRPC (httpBatchLink, credentials: include)
Express Server  [port 3000]
     ├── JWT session cookies (httpOnly, 1-year)
     ├── Rate limiting (100 req/15 min general, 10 uploads/15 min)
     ├── /files — authenticated local file server
     └── async calls to Python service
          ↕ X-Internal-Token header
FastAPI Python Service  [port 8001, internal only]
     ├── POST /api/process-pdf      → Gemini Vision OMR → MusicXML
     ├── POST /api/process-musicxml → music21 SATB detection
     └── POST /api/generate-midi    → per-voice MIDI files
MySQL 8.0  (Drizzle ORM)
     ├── users
     └── sheet_music
Local filesystem  (/var/lib/choir-files or LOCAL_STORAGE_DIR)
     └── sheet-music/<userId>/<sheetId>/{original,score.musicxml,midi/*.mid}
```

**Key directories:**

```
client/              React 19 frontend (Vite, Tailwind, shadcn/ui)
server/              Express + tRPC backend
  _core/             Express setup, JWT, tRPC init, logger, env validation
  routers.ts         All tRPC routes (auth, sheetMusic)
  db.ts              Drizzle ORM queries
  storage-active.ts  Active storage adapter (re-exports storage-local)
  storage-local.ts   Filesystem storage adapter (active)
  storage.ts         Cloud storage adapter (inactive, requires Forge API keys)
shared/              Types and constants shared between client and server
drizzle/             Schema and migrations
python_service/      FastAPI service (OMR, voice detection, MIDI generation)
deploy/              VPS deployment scripts (nginx, PM2, certbot)
```

---

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | Yes | MySQL connection string |
| `JWT_SECRET` | Yes | Session cookie signing key |
| `AUTH_PASSPHRASE` | Yes | Single-owner login passphrase |
| `GEMINI_API_KEY` | For PDF uploads | Google Gemini Vision API |
| `INTERNAL_SERVICE_TOKEN` | Recommended in prod | Shared secret between Node and Python service |
| `LOCAL_STORAGE_DIR` | No | File storage path (default: `/var/lib/choir-files`) |
| `PUBLIC_URL_BASE` | No | Public URL prefix for files (default: `/files`) |
| `PYTHON_SERVICE_URL` | No | Python service URL (default: `http://localhost:8001`) |
| `PORT` | No | HTTP port (default: `3000`) |
| `VITE_APP_TITLE` | No | Browser tab title (default: `Choir Voice Player`) |
| `VITE_APP_LOGO` | No | Logo image URL |

---

## Deployment

See [`deploy/DEPLOYMENT_GUIDE.md`](deploy/DEPLOYMENT_GUIDE.md) for full instructions.

**Quick summary:**

- **Docker Compose** (recommended for self-hosted): `docker compose up -d`
- **VPS (PM2 + nginx)**: run `deploy/setup.sh` then `deploy/deploy-app.sh`

The Docker image bundles the Node server and Python service in a single container. MySQL runs in a separate container with a named volume for persistence.

---

## Authentication

This is a **single-owner** app. There is no user registration. Log in with the passphrase configured in `AUTH_PASSPHRASE`. A JWT session cookie (`app_session_id`) is set on successful login and is valid for one year.

---

## Testing

```bash
pnpm test                               # Run all Vitest tests
pnpm test -- path/to/file.test.ts       # Run a single test file
```

Server-side tests live in `server/**/*.test.ts`.

---

## Security notes

- Passphrase comparison uses `timingSafeEqual` (Node crypto) to prevent timing attacks.
- Session tokens are JWT HS256 with a 1-year expiry stored in `httpOnly` cookies.
- File serving is authenticated; the server verifies both JWT session and file ownership before streaming any file.
- The Python service is internal-only (not port-mapped in Docker). Protect it with `INTERNAL_SERVICE_TOKEN` in production.
- Rate limiting: 100 requests / 15 min general; 10 uploads / 15 min per IP.

---

## Credits

- **OMR**: Google Gemini Vision API
- **Music Analysis**: [music21](https://web.mit.edu/music21/) by MIT
- **MIDI Playback**: [Tone.js](https://tonejs.github.io/)
- **UI Components**: [shadcn/ui](https://ui.shadcn.com/)
