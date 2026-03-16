# Choir Voice Player — Builder Fix Plan

> Generated from full audit on 2026-03-16. Execute phases in order.
> Repo: `/home/lex/.openclaw/workspace/choir-voice-player`

---

## Phase 1: Critical Security & Bug Fixes (must-do before any deploy)

### 1.1 — Fix path traversal in `server/storage-local.ts`

**File:** `server/storage-local.ts`  
**Problem:** `normalizeKey()` only strips literal `..` — encoded sequences bypass it. `createFileServerHandler()` joins `req.path` directly with no resolved-path check.

**Fix:**
```typescript
function normalizeKey(relKey: string): string {
  // Decode URI components first, then resolve
  const decoded = decodeURIComponent(relKey);
  // Strip null bytes
  const clean = decoded.replace(/\0/g, '');
  // Resolve to prevent traversal
  const resolved = path.resolve(STORAGE_DIR, clean);
  // MUST start with STORAGE_DIR
  if (!resolved.startsWith(path.resolve(STORAGE_DIR) + path.sep) && resolved !== path.resolve(STORAGE_DIR)) {
    throw new Error('Path traversal detected');
  }
  // Return relative key
  return path.relative(STORAGE_DIR, resolved);
}
```

Also fix `createFileServerHandler()`:
```typescript
export function createFileServerHandler() {
  return async (req: any, res: any, next: any) => {
    const requestedPath = decodeURIComponent(req.path.replace(/^\/files/, ''));
    const filePath = path.resolve(STORAGE_DIR, requestedPath.replace(/^\/+/, ''));
    
    // Prevent traversal
    if (!filePath.startsWith(path.resolve(STORAGE_DIR) + path.sep)) {
      return res.status(403).end();
    }
    
    if (!existsSync(filePath)) {
      return next();
    }
    // ... rest unchanged
  };
}
```

### 1.2 — Fix voice_assignments key type mismatch (Python)

**File:** `python_service/music_processor.py`, method `generate_midi_files()`  
**Problem:** JSON-parsed keys are strings (`"0"`, `"1"`) but `part_idx` from `enumerate()` is an int. `.get(part_idx)` never matches → empty MIDI files.

**Fix:** Change the function signature and lookup (around line 270):
```python
def generate_midi_files(
    self, 
    musicxml_path: str, 
    voice_assignments: Dict[str, str],  # keys are STRING indices
    output_dir: str
) -> Dict[str, str]:
    score = converter.parse(musicxml_path)
    voice_parts: Dict[str, List[stream.Part]] = {}
    
    for part_idx, part in enumerate(score.parts):
        voice_type = voice_assignments.get(str(part_idx), VoiceType.OTHER)  # str() key
        # ... rest unchanged
```

### 1.3 — Replace base64 file upload with multipart

**Files:** `server/routers.ts` (upload mutation), client `Upload.tsx`

**Problem:** Entire files sent as base64 JSON strings through tRPC. 50MB file = ~67MB in memory. Will OOM on concurrent uploads.

**Fix — Server side:** Add a separate Express route for file upload *outside* tRPC:

Create `server/upload-route.ts`:
```typescript
import express from 'express';
import multer from 'multer';
import { nanoid } from 'nanoid';
import { createSheetMusic, updateSheetMusic, getSheetMusic } from './db';
import { storagePut } from './storage-local';

const upload = multer({ 
  limits: { fileSize: 50 * 1024 * 1024 },
  storage: multer.memoryStorage()
});

export const uploadRouter = express.Router();

uploadRouter.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    
    // Auth check — extract user from req (reuse existing auth middleware)
    const user = (req as any).user;
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    
    const filename = req.file.originalname;
    const ext = filename.toLowerCase().split('.').pop();
    const fileType = ext === 'pdf' ? 'pdf' : 'musicxml';
    
    if (!['pdf', 'xml', 'musicxml', 'mxl'].includes(ext || '')) {
      return res.status(400).json({ error: 'Invalid file type' });
    }
    
    const sheetId = nanoid();
    const fileBuffer = req.file.buffer;
    const originalFileKey = `sheet-music/${user.id}/${sheetId}/original.${ext}`;
    
    const { key } = await storagePut(
      originalFileKey, fileBuffer,
      fileType === 'pdf' ? 'application/pdf' : 'application/xml'
    );
    
    const title = req.body.title || filename.replace(/\.[^/.]+$/, '');
    
    await createSheetMusic({
      id: sheetId, userId: user.id, title,
      originalFilename: filename, fileType,
      originalFileKey: key, status: 'processing',
    });
    
    // Fire async processing (import the helper from routers.ts or extract it)
    // processSheetMusicAsync(sheetId, fileBuffer, fileType);
    
    res.json({ id: sheetId, status: 'processing' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
```

**Fix — Client side (`Upload.tsx`):** Replace base64 encoding with `FormData`:
```typescript
const formData = new FormData();
formData.append('file', file);
formData.append('title', title);

const response = await fetch('/api/upload', {
  method: 'POST',
  body: formData,
  credentials: 'include', // send auth cookie
});
const result = await response.json();
```

**Add dependency:** `pnpm add multer && pnpm add -D @types/multer`

Remove the old `sheetMusic.upload` tRPC mutation from `routers.ts` (or keep as deprecated fallback).

### 1.4 — Add auth to Python service

**File:** `python_service/music_processor.py`

**Problem:** FastAPI endpoints have zero auth. Anyone reaching port 8001 can process files.

**Fix:** Add a shared secret header check:
```python
# At top of file
API_SECRET = os.environ.get("INTERNAL_API_SECRET", "")

from fastapi import Depends, Header

async def verify_internal_auth(x_internal_secret: str = Header(...)):
    if not API_SECRET:
        return  # No secret configured = dev mode
    if x_internal_secret != API_SECRET:
        raise HTTPException(403, "Forbidden")

# Add dependency to all endpoints:
@app.post("/api/process-pdf")
async def process_pdf(file: UploadFile = File(...), _auth=Depends(verify_internal_auth)):
    ...

@app.post("/api/process-musicxml")
async def process_musicxml(file: UploadFile = File(...), _auth=Depends(verify_internal_auth)):
    ...

@app.post("/api/generate-midi")
async def generate_midi(musicxml: str = Form(...), voice_assignments: str = Form(...), _auth=Depends(verify_internal_auth)):
    ...
```

**Server side (Node):** Add the secret header to all Python service calls in `routers.ts`:
```typescript
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET || '';

// In processSheetMusicAsync and regenerateMidiAsync:
const response = await fetch(`${PYTHON_SERVICE_URL}${endpoint}`, {
  method: 'POST',
  body: formData as any,
  headers: {
    ...formData.getHeaders(),
    'X-Internal-Secret': INTERNAL_API_SECRET,
  },
});
```

### 1.5 — Lock down Python CORS

**File:** `python_service/music_processor.py`

**Fix:** Replace the wildcard with the actual app origin:
```python
ALLOWED_ORIGINS = os.getenv("ALLOWED_ORIGINS", "http://localhost:3000").split(",")
```

### 1.6 — Fix health check (stop burning Gemini tokens)

**File:** `python_service/music_processor.py`, `/health` endpoint

**Fix:** Just check config, don't call the API:
```python
@app.get("/health")
async def health_check():
    return {
        "status": "healthy",
        "gemini_configured": bool(os.environ.get("GEMINI_API_KEY")),
        "music21_available": True,  # already imported
    }
```

---

## Phase 2: Bug Fixes & Data Integrity

### 2.1 — Fix missing `index` import in schema

**File:** `drizzle/schema.ts`

**Fix:** Add `index` to the import:
```typescript
import { mysqlEnum, mysqlTable, text, timestamp, varchar, int, json, index } from "drizzle-orm/mysql-core";
```

### 2.2 — Add pagination to list endpoint

**File:** `server/routers.ts` — `sheetMusic.list`

**Fix:**
```typescript
list: protectedProcedure
  .input(z.object({
    limit: z.number().min(1).max(100).default(20),
    offset: z.number().min(0).default(0),
  }).optional())
  .query(async ({ ctx, input }) => {
    return await getUserSheetMusic(ctx.user.id, input?.limit ?? 20, input?.offset ?? 0);
  }),
```

**File:** `server/db.ts` — update `getUserSheetMusic`:
```typescript
export async function getUserSheetMusic(userId: string, limit = 20, offset = 0): Promise<SheetMusic[]> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  return await db.select()
    .from(sheetMusic)
    .where(eq(sheetMusic.userId, userId))
    .orderBy(desc(sheetMusic.createdAt))
    .limit(limit)
    .offset(offset);
}
```

### 2.3 — Validate voice assignment values

**File:** `server/routers.ts` — `updateVoiceAssignments`

**Fix:** Restrict values to valid voice types:
```typescript
voiceAssignments: z.record(
  z.string().regex(/^\d+$/),  // keys must be numeric strings
  z.enum(["soprano", "alto", "tenor", "bass", "other"])
),
```

### 2.4 — Add stuck-processing recovery

**File:** `server/db.ts`

**Add:**
```typescript
export async function recoverStuckProcessing(timeoutMinutes = 30): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  
  const cutoff = new Date(Date.now() - timeoutMinutes * 60 * 1000);
  const result = await db.update(sheetMusic)
    .set({ status: 'error', errorMessage: 'Processing timed out' })
    .where(and(
      eq(sheetMusic.status, 'processing'),
      lt(sheetMusic.updatedAt, cutoff)
    ));
  
  return result[0]?.affectedRows ?? 0;
}
```

Call it on server startup and optionally on a setInterval (every 5 min).

### 2.5 — Add retry logic for Python service calls

**File:** `server/routers.ts` — `processSheetMusicAsync`

**Wrap the fetch call:**
```typescript
async function fetchWithRetry(url: string, options: any, retries = 3, delayMs = 2000): Promise<any> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, options);
      if (response.ok) return response;
      if (response.status >= 500 && attempt < retries) {
        await new Promise(r => setTimeout(r, delayMs * attempt));
        continue;
      }
      return response; // Return non-retryable errors
    } catch (err) {
      if (attempt === retries) throw err;
      await new Promise(r => setTimeout(r, delayMs * attempt));
    }
  }
}
```

---

## Phase 3: Cleanup & Dependency Diet

### 3.1 — Remove dead code and Manus coupling

**Delete these files:**
- `server/storage.ts` (dead Manus cloud adapter)
- `client/src/components/ManusDialog.tsx`

**Edit `client/src/_core/hooks/useAuth.ts`:**
- Remove `localStorage.setItem("manus-runtime-user-info", ...)` (line ~35)

**Edit `server/_core/env.ts`:**
- Remove `forgeApiUrl` and `forgeApiKey` (Manus Forge references)

**Edit `vite.config.ts`:**
- Remove `vite-plugin-manus-runtime` import and usage if present

### 3.2 — Dependency cleanup (package.json)

**Remove unused dependencies:**
```bash
pnpm remove @aws-sdk/client-s3 @aws-sdk/s3-request-presigner stripe @stripe/stripe-js \
  @radix-ui/react-accordion @radix-ui/react-alert-dialog @radix-ui/react-aspect-ratio \
  @radix-ui/react-avatar @radix-ui/react-checkbox @radix-ui/react-collapsible \
  @radix-ui/react-context-menu @radix-ui/react-hover-card @radix-ui/react-menubar \
  @radix-ui/react-navigation-menu @radix-ui/react-popover @radix-ui/react-progress \
  @radix-ui/react-radio-group @radix-ui/react-scroll-area @radix-ui/react-slider \
  @radix-ui/react-switch @radix-ui/react-toggle @radix-ui/react-toggle-group \
  axios cmdk date-fns embla-carousel-react input-otp midi-writer-js next-themes \
  react-day-picker react-hook-form react-resizable-panels recharts vaul framer-motion
```

**Keep:** `@radix-ui/react-dialog`, `@radix-ui/react-dropdown-menu`, `@radix-ui/react-label`, `@radix-ui/react-select`, `@radix-ui/react-separator`, `@radix-ui/react-slot`, `@radix-ui/react-tabs`, `@radix-ui/react-tooltip` (verify against actual imports in used components first).

**Verify before removing:** Run `grep -r "from.*radix" client/src/pages/ client/src/components/Header.tsx client/src/components/MidiPlayer.tsx client/src/components/ErrorBoundary.tsx` to confirm which Radix packages are actually imported in non-`ui/` files. Only the `ui/` components that are actually used need to stay.

### 3.3 — Remove unused `ui/` components

**Keep only what's imported.** Run:
```bash
for f in client/src/components/ui/*.tsx; do
  name=$(basename "$f" .tsx)
  count=$(grep -r "from.*ui/$name" client/src/pages/ client/src/components/*.tsx --include='*.tsx' | wc -l)
  if [ "$count" -eq 0 ]; then
    echo "UNUSED: $name"
  fi
done
```

Delete all UNUSED ones. Should cut ~40+ files.

---

## Phase 4: Docker & DevOps Fixes

### 4.1 — Create `python_service/requirements.txt`

```
fastapi>=0.104.0
uvicorn>=0.24.0
music21>=9.1.0
google-generativeai>=0.3.0
pdf2image>=1.16.3
Pillow>=10.0.0
python-multipart>=0.0.6
python-dotenv>=1.0.0
```

### 4.2 — Fix Dockerfile (proper process management)

Replace the fragile `CMD` with a proper process supervisor:

```dockerfile
# Final combined stage
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
COPY --from=backend /app/server /app/server
COPY --from=backend /app/shared /app/shared
COPY --from=backend /app/drizzle /app/drizzle
COPY --from=backend /app/package.json /app/
COPY --from=frontend-builder /app/dist /app/dist

# Volumes
VOLUME ["/var/lib/choir-files"]

EXPOSE 3000 8001

# Use a simple shell script for process management
COPY docker-entrypoint.sh /app/
RUN chmod +x /app/docker-entrypoint.sh
CMD ["/app/docker-entrypoint.sh"]
```

Create `docker-entrypoint.sh`:
```bash
#!/bin/sh
set -e

# Start Python service in background
python3 /app/python_service/music_processor.py &
PYTHON_PID=$!

# Start Node.js app
node /app/dist/index.js &
NODE_PID=$!

# Wait for either to exit, then kill the other
wait -n $PYTHON_PID $NODE_PID
EXIT_CODE=$?

kill $PYTHON_PID $NODE_PID 2>/dev/null || true
exit $EXIT_CODE
```

### 4.3 — Update docker-compose.yml

```yaml
version: '3.8'

services:
  app:
    build: .
    ports:
      - "3000:3000"
    environment:
      - DATABASE_URL=${DATABASE_URL}
      - JWT_SECRET=${JWT_SECRET}
      - GEMINI_API_KEY=${GEMINI_API_KEY}
      - INTERNAL_API_SECRET=${INTERNAL_API_SECRET}
      - PYTHON_SERVICE_URL=http://localhost:8001
      - LOCAL_STORAGE_DIR=/var/lib/choir-files
      - PUBLIC_URL_BASE=${PUBLIC_URL_BASE:-http://localhost:3000/files}
      - ALLOWED_ORIGINS=${ALLOWED_ORIGINS:-http://localhost:3000}
      - NODE_ENV=production
    depends_on:
      - db
    volumes:
      - choir_files:/var/lib/choir-files
    restart: unless-stopped

  db:
    image: mysql:8.0
    restart: always
    environment:
      MYSQL_ROOT_PASSWORD: ${MYSQL_ROOT_PASSWORD:-rootpassword}
      MYSQL_DATABASE: choir_voice_player
    ports:
      - "3306:3306"
    volumes:
      - mysql_data:/var/lib/mysql

volumes:
  mysql_data:
  choir_files:
```

### 4.4 — Create `.env.example`

```env
# Database
DATABASE_URL=mysql://root:rootpassword@db:3306/choir_voice_player

# Auth
JWT_SECRET=change-me-to-random-64-char-string

# Gemini API (for PDF OMR)
GEMINI_API_KEY=your-gemini-api-key
GEMINI_MODEL_NAME=gemini-2.0-flash

# Internal service auth
INTERNAL_API_SECRET=change-me-to-random-string

# Storage
LOCAL_STORAGE_DIR=/var/lib/choir-files
PUBLIC_URL_BASE=https://yourdomain.com/files

# CORS (Python service)
ALLOWED_ORIGINS=https://yourdomain.com

# Node
NODE_ENV=production
```

### 4.5 — Update default Gemini model

**File:** `python_service/music_processor.py` line ~125
```python
model_name = os.environ.get("GEMINI_MODEL_NAME", "gemini-2.0-flash")
```

---

## Phase 5: Frontend Polish (optional, low priority)

### 5.1 — Add processing timeout UI

**File:** `client/src/pages/SheetDetail.tsx`

Add a client-side timeout indicator: if status is `"processing"` for >2 minutes, show "Processing is taking longer than expected. You can try re-uploading." with a retry button.

### 5.2 — Remove stale localStorage writes

**File:** `client/src/_core/hooks/useAuth.ts`
Remove the `manus-runtime-user-info` localStorage write entirely.

---

## Execution Order

| Phase | Effort | Risk | Description |
|-------|--------|------|-------------|
| 1 | ~2h | High (security) | Critical security + bug fixes |
| 2 | ~1h | Medium | Data integrity + resilience |
| 3 | ~30min | Low | Cleanup, remove ~40 unused files + deps |
| 4 | ~1h | Medium | Docker + deploy readiness |
| 5 | ~20min | Low | Frontend polish |

**Total estimated: ~5 hours of Builder time.**

## Test Checklist (Inspector should verify)

- [ ] Upload a PDF → verify MIDI files are generated (not empty)
- [ ] Upload a MusicXML → verify voice detection + MIDI
- [ ] Try path traversal: `GET /files/../../../etc/passwd` → should 403
- [ ] Hit Python endpoints without `X-Internal-Secret` header → should 403
- [ ] Hit `/health` → verify no Gemini API call (check logs)
- [ ] Verify `pnpm build` succeeds after dependency cleanup
- [ ] Verify Docker build completes
- [ ] Verify `docker compose up` runs both services
