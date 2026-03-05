# App Improvements Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix 10 bugs, add CI/observability improvements, and deliver 7 UX enhancements across 3 phases (22 items total).

**Architecture:** Phases are independent and ordered by risk: bugs first, then CI guardrails, then new features. Within each phase, tasks are independent unless noted.

**Tech Stack:** React 19, tRPC 11, Tone.js, Express, FastAPI (Python), Vitest, GitHub Actions

---

## Phase 1: Bug Fixes & Reliability

### Task 1: Parallelize MIDI URL fetches in SheetDetail

**Files:**
- Modify: `client/src/pages/SheetDetail.tsx:145-189`

**Step 1: Replace sequential loop with Promise.allSettled**

In `SheetDetail.tsx`, replace the `loadMidiUrls` function (lines 148-174):

```tsx
const loadMidiUrls = async () => {
  if (sheet?.status === "ready" && sheet.midiFileKeys && !isCancelled) {
    const keys = sheet.midiFileKeys as Record<string, string>;
    const entries = Object.keys(keys);

    const results = await Promise.allSettled(
      entries.map(async (voice) => {
        const result = await utils.sheetMusic.getMidiUrl.fetch({
          id: sheetId,
          voice,
        });
        return { voice, url: result.url };
      })
    );

    if (isCancelled) return;

    const urls: Record<string, string> = {};
    const failed: string[] = [];
    for (const r of results) {
      if (r.status === "fulfilled") {
        urls[r.value.voice] = r.value.url;
      } else {
        failed.push("voice");
      }
    }

    setMidiUrls(urls);
    if (failed.length > 0 && failed.length < entries.length) {
      toast.warning(`Could not load MIDI for some voices. Other voices are still playable.`);
    } else if (failed.length === entries.length) {
      toast.error("Failed to load MIDI files. Please refresh the page.");
    }
  }
};
```

**Step 2: Run `pnpm check` to verify types**

Run: `pnpm check`
Expected: PASS

**Step 3: Commit**

```bash
git add client/src/pages/SheetDetail.tsx
git commit -m "fix: parallelize MIDI URL fetches with Promise.allSettled"
```

---

### Task 2: Fix Settings initialization race condition

**Files:**
- Modify: `client/src/pages/Settings.tsx:18-30`

**Step 1: Replace useState-in-body with useEffect**

Replace lines 18-30:

```tsx
const [apiKey, setApiKey] = useState("");
const [showApiKey, setShowApiKey] = useState(false);
const [modelName, setModelName] = useState("");
const [maxTokens, setMaxTokens] = useState("");
const [hasEdited, setHasEdited] = useState(false);
const [initialized, setInitialized] = useState(false);

// Populate defaults from server config when loaded
useEffect(() => {
  if (config && !initialized) {
    setModelName(config.modelName);
    setMaxTokens(String(config.maxOutputTokens));
    setInitialized(true);
  }
}, [config, initialized]);
```

**Step 2: Run `pnpm check`**

Run: `pnpm check`
Expected: PASS

**Step 3: Commit**

```bash
git add client/src/pages/Settings.tsx
git commit -m "fix: move Settings config init to useEffect"
```

---

### Task 3: Add sheet title to MIDI download filenames

**Files:**
- Modify: `client/src/components/MidiPlayer.tsx:17-19, 516`
- Modify: `client/src/pages/SheetDetail.tsx:429-432`

**Step 1: Add `sheetTitle` prop to MidiPlayer**

In `MidiPlayer.tsx`, update the interface (line 17-19):

```tsx
interface MidiPlayerProps {
  midiUrls: Record<string, string>;
  availableVoices: string[];
  sheetTitle?: string;
}
```

Update component signature (line 34):

```tsx
export default function MidiPlayer({ midiUrls, availableVoices, sheetTitle }: MidiPlayerProps) {
```

Add a sanitize helper above the component:

```tsx
function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9\-_ ]/g, "").trim().replace(/\s+/g, "-") || "sheet";
}
```

Update the download link (line 516):

```tsx
download={`${sheetTitle ? sanitizeFilename(sheetTitle) + "-" : ""}${control.label.toLowerCase()}.mid`}
```

**Step 2: Pass sheetTitle from SheetDetail**

In `SheetDetail.tsx` line 429-432, add the prop:

```tsx
<MidiPlayer
  midiUrls={midiUrls}
  availableVoices={availableVoices}
  sheetTitle={sheet.title}
/>
```

**Step 3: Run `pnpm check`**

Run: `pnpm check`
Expected: PASS

**Step 4: Commit**

```bash
git add client/src/components/MidiPlayer.tsx client/src/pages/SheetDetail.tsx
git commit -m "fix: include sheet title in MIDI download filenames"
```

---

### Task 4: Fix stale footer year

**Files:**
- Modify: `client/src/pages/Home.tsx:280`

**Step 1: Replace hardcoded year**

Change line 280 from:

```tsx
<p>© 2025 Choir Voice Player. Built for choir directors and singers.</p>
```

to:

```tsx
<p>© {new Date().getFullYear()} {APP_TITLE}. Built for choir directors and singers.</p>
```

**Step 2: Commit**

```bash
git add client/src/pages/Home.tsx
git commit -m "fix: use dynamic year and APP_TITLE in footer"
```

---

### Task 5: Add voice assignment save error toast

**Files:**
- Modify: `client/src/pages/SheetDetail.tsx:117-126`

**Step 1: Verify**

Check that `updateVoicesMutation` already has an `onError` handler. Looking at lines 117-126:

```tsx
const updateVoicesMutation = trpc.sheetMusic.updateVoiceAssignments.useMutation({
  onSuccess: () => {
    toast.success("Voice assignments updated!");
    setHasChanges(false);
    refetch();
  },
  onError: (error) => {
    toast.error(`Failed to update: ${error.message}`);
  },
});
```

This already has error handling. **Skip this task — already implemented.**

---

### Task 6: Add music21 parsing timeout in Python service

**Files:**
- Modify: `python_service/music_processor.py:893, 935, 899, 950`

**Step 1: Add timeout wrapper to process_pdf**

In `music_processor.py`, modify the `_run()` function inside `process_pdf` (line 885-896) to add a timeout:

```python
def _run():
    with create_temp_processor() as processor:
        pdf_path = os.path.join(processor.temp_dir, "input.pdf")
        with open(pdf_path, 'wb') as f:
            f.write(file_content)
        musicxml_path = processor.process_pdf(pdf_path)
        analysis = processor.analyze_musicxml(musicxml_path)
        with open(musicxml_path, 'r', encoding="utf-8") as f:
            musicxml_content = f.read()
        return {"success": True, "musicxml": musicxml_content, "analysis": analysis}

try:
    result = await asyncio.wait_for(asyncio.to_thread(_run), timeout=180)
    return JSONResponse(result)
```

**Step 2: Do the same for process_musicxml**

Modify line 950:

```python
result = await asyncio.wait_for(asyncio.to_thread(_run), timeout=120)
```

**Step 3: Do the same for generate_midi**

Modify line 1009:

```python
result = await asyncio.wait_for(asyncio.to_thread(_run), timeout=60)
```

**Step 4: Add TimeoutError handling**

In each endpoint's `except` block, add before the generic `Exception` handler:

```python
except asyncio.TimeoutError:
    logger.error("Processing timed out for %s", endpoint_name)
    raise HTTPException(504, detail=json.dumps({
        "error_category": "network",
        "error_message": "Processing timed out. The score may be too complex — try fewer pages.",
    }))
```

**Step 5: Commit**

```bash
git add python_service/music_processor.py
git commit -m "fix: add asyncio.wait_for timeouts to all Python endpoints"
```

---

### Task 7: Validate MIDI file size before returning

**Files:**
- Modify: `python_service/music_processor.py:1002-1006`

**Step 1: Add size check**

In `generate_midi` endpoint, after reading MIDI files (lines 1002-1005), add validation:

```python
midi_data = {}
for voice_type, midi_path in midi_files.items():
    with open(midi_path, 'rb') as f:
        content = f.read()
    if len(content) == 0:
        logger.warning("Empty MIDI file generated for voice: %s", voice_type)
        continue
    midi_data[voice_type] = base64.b64encode(content).decode('utf-8')

if not midi_data:
    raise HTTPException(500, detail=json.dumps({
        "error_category": "parse",
        "error_message": "No MIDI data could be generated from the score.",
    }))
```

**Step 2: Commit**

```bash
git add python_service/music_processor.py
git commit -m "fix: validate MIDI files are non-empty before returning"
```

---

### Task 8: Surface PDF page truncation warning

**Files:**
- Modify: `python_service/music_processor.py` (process_pdf response)
- Modify: `server/routers.ts:630-634` (parse warnings from response)
- Modify: `client/src/pages/SheetDetail.tsx` (display warning)

**Step 1: Return warnings from Python service**

In `process_pdf`, modify the `_run()` function to track warnings:

```python
def _run():
    with create_temp_processor() as processor:
        pdf_path = os.path.join(processor.temp_dir, "input.pdf")
        with open(pdf_path, 'wb') as f:
            f.write(file_content)
        warnings = []
        # Check page count before processing
        doc = fitz.open(pdf_path)
        total_pages = len(doc)
        doc.close()
        if total_pages > PDF_MAX_PAGES:
            warnings.append(f"PDF has {total_pages} pages; only the first {PDF_MAX_PAGES} were processed.")
        musicxml_path = processor.process_pdf(pdf_path)
        analysis = processor.analyze_musicxml(musicxml_path)
        with open(musicxml_path, 'r', encoding="utf-8") as f:
            musicxml_content = f.read()
        return {"success": True, "musicxml": musicxml_content, "analysis": analysis, "warnings": warnings}
```

**Step 2: Propagate warnings through the Node server**

In `server/routers.ts`, update `processSheetMusicAsync` (around line 630) to store warnings:

```typescript
const result = await response.json() as {
  success: boolean;
  musicxml: string;
  analysis: any;
  warnings?: string[];
};
```

Store warnings in the analysis result or as a separate field. Simplest approach: include in `analysisResult`:

```typescript
if (result.warnings?.length) {
  result.analysis.warnings = result.warnings;
}
```

**Step 3: Display warnings in SheetDetail**

In `SheetDetail.tsx`, after the "Voice Assignments" card (around line 337), add:

```tsx
{analysis?.warnings?.length > 0 && (
  <div className="flex items-center gap-3 p-3 bg-yellow-50 border border-yellow-200 rounded-lg text-yellow-800 dark:bg-yellow-900/20 dark:border-yellow-800 dark:text-yellow-400">
    <AlertTriangle className="h-4 w-4 flex-shrink-0" />
    <div className="text-sm">
      {analysis.warnings.map((w: string, i: number) => (
        <p key={i}>{w}</p>
      ))}
    </div>
  </div>
)}
```

**Step 4: Run `pnpm check`**

Run: `pnpm check`
Expected: PASS

**Step 5: Commit**

```bash
git add python_service/music_processor.py server/routers.ts client/src/pages/SheetDetail.tsx
git commit -m "fix: surface PDF page truncation warnings to the user"
```

---

### Task 9: Validate Gemini model name on config save

**Files:**
- Modify: `python_service/music_processor.py:1034-1062`

**Step 1: Add model validation in update-config**

In the `/api/update-config` endpoint, after updating `gemini_model_name`, validate it:

```python
if "gemini_model_name" in body and isinstance(body["gemini_model_name"], str):
    model_name = body["gemini_model_name"].strip()
    if not model_name:
        raise HTTPException(400, detail="Model name cannot be empty")
    _config["gemini_model_name"] = model_name

# Rebuild client first so validation uses the new key if both changed
_rebuild_genai_client()

# Validate model name if client is available and model was changed
if "gemini_model_name" in body and GENAI_CLIENT:
    try:
        GENAI_CLIENT.models.get(model=_config["gemini_model_name"])
    except Exception as e:
        logger.warning("Model validation failed: %s", e)
        # Don't block the save — just warn. The user can fix via Settings.
```

**Step 2: Commit**

```bash
git add python_service/music_processor.py
git commit -m "fix: validate Gemini model name on config update"
```

---

## Phase 2: CI & Observability

### Task 10: Add build verification to CI

**Files:**
- Modify: `.github/workflows/ci.yml`

**Step 1: Add build step**

After the type-check step (line 30), add:

```yaml
      - name: Build
        run: pnpm build
```

**Step 2: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add pnpm build step to verify build succeeds"
```

---

### Task 11: Add ESLint with minimal config

**Files:**
- Create: `eslint.config.js`
- Modify: `package.json` (add lint script)
- Modify: `.github/workflows/ci.yml`

**Step 1: Install ESLint dependencies**

```bash
pnpm add -D eslint @eslint/js typescript-eslint eslint-plugin-react-hooks
```

**Step 2: Create eslint.config.js (flat config)**

```js
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    },
  },
  {
    ignores: ["dist/", "node_modules/", "drizzle/", "*.cjs"],
  }
);
```

**Step 3: Add lint script to package.json**

```json
"lint": "eslint . --max-warnings 0"
```

**Step 4: Run and fix initial errors**

```bash
pnpm lint
```

Fix any errors. Use `--max-warnings 50` initially if needed, then reduce over time.

**Step 5: Add to CI**

```yaml
      - name: Lint
        run: pnpm lint
```

**Step 6: Commit**

```bash
git add eslint.config.js package.json pnpm-lock.yaml .github/workflows/ci.yml
git commit -m "ci: add ESLint with typescript-eslint + react-hooks"
```

---

### Task 12: Add upload request logging

**Files:**
- Modify: `server/routers.ts:122-137`

**Step 1: Add logging after size validation**

After the size check (line 136), add:

```typescript
logger.info("Sheet music upload", {
  sheetId,
  userId,
  filename: input.filename,
  fileType: input.fileType,
  sizeBytes: fileBuffer.length,
});
```

**Step 2: Commit**

```bash
git add server/routers.ts
git commit -m "feat: log upload metadata (filename, type, size)"
```

---

### Task 13: Add Python service latency tracking

**Files:**
- Modify: `server/routers.ts:604-623, 740-751`

**Step 1: Add timing around Python service calls**

Wrap the Python service fetch in `processSheetMusicAsync` (around line 614):

```typescript
const fetchStart = Date.now();
const response = await fetch(`${PYTHON_SERVICE_URL}${endpoint}`, { ... });
clearTimeout(timeoutId);
logger.info("Python service responded", {
  sheetId,
  endpoint,
  durationMs: Date.now() - fetchStart,
  status: response.status,
});
```

**Step 2: Same for MIDI generation**

Wrap the MIDI fetch in `regenerateMidiAsync` (around line 742):

```typescript
const midiStart = Date.now();
const response = await fetch(`${PYTHON_SERVICE_URL}/api/generate-midi`, { ... });
clearTimeout(midiTimeoutId);
logger.info("MIDI generation responded", {
  sheetId,
  durationMs: Date.now() - midiStart,
  status: response.status,
});
```

**Step 3: Commit**

```bash
git add server/routers.ts
git commit -m "feat: log Python service call latency"
```

---

### Task 14: Add voice assignment audit logging

**Files:**
- Modify: `server/routers.ts:225-242`

**Step 1: Log before and after**

In `updateVoiceAssignments`, after fetching the sheet and before updating:

```typescript
logger.info("Voice assignments updated", {
  sheetId: input.id,
  userId: ctx.user.id,
  oldAssignments: sheet.voiceAssignments,
  newAssignments: input.voiceAssignments,
});
```

**Step 2: Commit**

```bash
git add server/routers.ts
git commit -m "feat: log voice assignment changes for audit trail"
```

---

## Phase 3: UX Improvements

### Task 15: Add SSE endpoint for real-time processing updates

**Files:**
- Create: `server/sse.ts`
- Modify: `server/_core/index.ts` (mount SSE route)
- Modify: `server/routers.ts` (emit events during processing)
- Modify: `client/src/pages/SheetDetail.tsx` (subscribe to SSE)

**Step 1: Create server/sse.ts**

```typescript
import { EventEmitter } from "events";
import { Router, Request, Response } from "express";
import { sdk } from "./_core/sdk";
import cookie from "cookie";
import { COOKIE_NAME } from "@shared/const";
import { getSheetMusic } from "./db";

// In-memory event bus keyed by sheetId
export const processingEvents = new EventEmitter();
processingEvents.setMaxListeners(100);

export function emitProcessingEvent(sheetId: string, event: string, data: Record<string, unknown>) {
  processingEvents.emit(sheetId, { event, data });
}

const sseRouter = Router();

sseRouter.get("/api/sse/sheet/:id", async (req: Request, res: Response) => {
  const sheetId = req.params.id;

  // Auth check
  const cookies = cookie.parse(req.headers.cookie || "");
  const token = cookies[COOKIE_NAME];
  if (!token) { res.status(401).end(); return; }

  let session;
  try { session = await sdk.verifySession(token); }
  catch { res.status(401).end(); return; }

  // Ownership check
  const sheet = await getSheetMusic(sheetId);
  if (!sheet || sheet.userId !== session.userId) {
    res.status(404).end();
    return;
  }

  // SSE headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();

  // Send current status immediately
  res.write(`event: status\ndata: ${JSON.stringify({ status: sheet.status, errorMessage: sheet.errorMessage })}\n\n`);

  const listener = ({ event, data }: { event: string; data: Record<string, unknown> }) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  processingEvents.on(sheetId, listener);

  // Heartbeat every 30s to keep connection alive
  const heartbeat = setInterval(() => {
    res.write(":heartbeat\n\n");
  }, 30_000);

  req.on("close", () => {
    processingEvents.off(sheetId, listener);
    clearInterval(heartbeat);
  });
});

export { sseRouter };
```

**Step 2: Mount SSE route in server/_core/index.ts**

Add after the tRPC middleware:

```typescript
import { sseRouter } from "../sse";
app.use(sseRouter);
```

**Step 3: Emit events from processSheetMusicAsync**

In `server/routers.ts`, import and call `emitProcessingEvent` at each pipeline step:

```typescript
import { emitProcessingEvent } from "./sse";
```

Add calls in `processSheetMusicAsync`:

```typescript
// After health check (line 598)
emitProcessingEvent(sheetId, "processing_step", {
  step: fileType === "pdf" ? "Reading score (OCR)..." : "Parsing score...",
});

// After Python response (line 640)
emitProcessingEvent(sheetId, "processing_step", { step: "Storing score..." });

// Before MIDI generation (line 657)
emitProcessingEvent(sheetId, "processing_step", { step: "Generating MIDI files..." });

// On completion (line 663)
emitProcessingEvent(sheetId, "status_changed", { status: "ready" });

// On error (line 667)
emitProcessingEvent(sheetId, "status_changed", { status: "error", errorMessage: ... });
```

**Step 4: Subscribe in SheetDetail.tsx**

Add a `useEffect` that connects to SSE while processing:

```tsx
useEffect(() => {
  if (sheet?.status !== "processing") return;

  const es = new EventSource(`/api/sse/sheet/${sheetId}`, { withCredentials: true });

  es.addEventListener("processing_step", (e) => {
    const data = JSON.parse(e.data);
    // Update the processing message displayed to the user
    setProcessingStep(data.step);
  });

  es.addEventListener("status_changed", (e) => {
    const data = JSON.parse(e.data);
    if (data.status === "ready" || data.status === "error") {
      refetch(); // Refresh full data from server
    }
  });

  es.onerror = () => {
    es.close();
    // Falls back to existing 3s polling (already active via refetchInterval)
  };

  return () => es.close();
}, [sheet?.status, sheetId]);
```

Add `processingStep` state and display it in the processing card.

**Step 5: Run `pnpm check`**

Run: `pnpm check`
Expected: PASS

**Step 6: Commit**

```bash
git add server/sse.ts server/_core/index.ts server/routers.ts client/src/pages/SheetDetail.tsx
git commit -m "feat: add SSE for real-time processing status updates"
```

---

### Task 16: Per-voice keyboard shortcuts in MidiPlayer

**Files:**
- Modify: `client/src/components/MidiPlayer.tsx:266-301, 469-471`

**Step 1: Add number key handlers**

In the keyboard handler (line 267-301), add after the `m`/`M` block:

```tsx
} else if (e.key >= "1" && e.key <= "9") {
  const idx = parseInt(e.key, 10) - 1;
  setVoiceControls(prev => {
    if (idx >= prev.length) return prev;
    const target = prev[idx];
    const updated = prev.map((vc, i) => i === idx ? { ...vc, muted: !vc.muted } : vc);
    const synth = synthsRef.current.get(target.voice);
    if (synth) {
      const newMuted = !target.muted;
      const effectiveMuted = newMuted || (soloVoiceRef.current !== null && soloVoiceRef.current !== target.voice);
      synth.volume.value = effectiveMuted ? -Infinity : Tone.gainToDb(target.volume);
    }
    return updated;
  });
}
```

**Step 2: Add shortcut tooltip to voice controls**

In the voice control UI (around line 498-500), update the label span:

```tsx
<span className="text-sm font-medium dark:text-gray-200">
  {control.label}
  <span className="ml-1 text-xs text-muted-foreground opacity-60">
    [{voiceControls.indexOf(control) + 1}]
  </span>
</span>
```

**Step 3: Add visual mute dimming**

On the voice control container (line 478-480), add conditional opacity:

```tsx
className={`flex items-center gap-3 p-3 border-2 rounded-lg dark:bg-gray-700 ${colors.border} ${
  effectiveMuted ? "opacity-40" : ""
}`}
```

Add strikethrough to the label when muted:

```tsx
<span className={`text-sm font-medium dark:text-gray-200 ${effectiveMuted ? "line-through" : ""}`}>
```

**Step 4: Run `pnpm check`**

Run: `pnpm check`
Expected: PASS

**Step 5: Commit**

```bash
git add client/src/components/MidiPlayer.tsx
git commit -m "feat: per-voice keyboard shortcuts (1-4) + visual mute indicators"
```

---

### Task 17: File type badge in Upload page

**Files:**
- Modify: `client/src/pages/Upload.tsx`

**Step 1: Add file type badge after selection**

Find where the selected filename is displayed (around the file info area). Add a badge:

```tsx
import { Badge } from "@/components/ui/badge";
import { FileText, FileCode } from "lucide-react";
```

Next to the filename display:

```tsx
{selectedFile && (
  <div className="flex items-center gap-2 mt-2">
    {selectedFile.name.toLowerCase().endsWith('.pdf') ? (
      <Badge variant="secondary" className="flex items-center gap-1">
        <FileText className="h-3 w-3" /> PDF
      </Badge>
    ) : (
      <Badge variant="secondary" className="flex items-center gap-1">
        <FileCode className="h-3 w-3" /> MusicXML
      </Badge>
    )}
    <span className="text-sm text-muted-foreground">
      {(selectedFile.size / 1024 / 1024).toFixed(1)} MB
    </span>
  </div>
)}
```

**Step 2: Run `pnpm check`**

Run: `pnpm check`
Expected: PASS

**Step 3: Commit**

```bash
git add client/src/pages/Upload.tsx
git commit -m "feat: show file type badge and size before upload"
```

---

### Task 18: Dynamic skeleton count on Home page

**Files:**
- Modify: `client/src/pages/Home.tsx:117-131`

**Step 1: Use placeholderData for count**

Update the query (line 21) to use `placeholderData`:

```tsx
const { data: userSheets, isLoading: sheetsLoading, isError: sheetsError } = trpc.sheetMusic.list.useQuery(undefined, {
  enabled: !!user,
  placeholderData: (prev) => prev,
});
```

Update the skeleton count (line 119):

```tsx
{[...Array(userSheets?.length || 3)].map((_, i) => (
```

**Step 2: Run `pnpm check`**

Run: `pnpm check`
Expected: PASS

**Step 3: Commit**

```bash
git add client/src/pages/Home.tsx
git commit -m "feat: use previous data length for skeleton card count"
```

---

### Task 19: Bulk delete on Home page

**Files:**
- Modify: `client/src/pages/Home.tsx`
- Modify: `server/routers.ts` (add `deleteMany` procedure)

**Step 1: Add deleteMany tRPC procedure**

In `server/routers.ts`, add inside the `sheetMusic` router (after `delete`):

```typescript
deleteMany: protectedProcedure
  .input(z.object({ ids: z.array(z.string().min(1).max(64)).min(1).max(50) }))
  .mutation(async ({ ctx, input }) => {
    const results = await Promise.allSettled(
      input.ids.map(async (id) => {
        const sheet = await getSheetMusic(id);
        if (!sheet || sheet.userId !== ctx.user.id) return;

        // Delete storage files
        const deletePromises: Promise<void>[] = [];
        if (sheet.originalFileKey) {
          deletePromises.push(storageDelete(sheet.originalFileKey).catch(() => {}));
        }
        if (sheet.musicxmlKey) {
          deletePromises.push(storageDelete(sheet.musicxmlKey).catch(() => {}));
        }
        if (sheet.midiFileKeys) {
          const midiKeys = sheet.midiFileKeys as Record<string, string>;
          for (const key of Object.values(midiKeys)) {
            if (key) deletePromises.push(storageDelete(key).catch(() => {}));
          }
        }
        await Promise.all(deletePromises);
        await deleteSheetMusic(id);
      })
    );

    const deleted = results.filter(r => r.status === "fulfilled").length;
    return { deleted, total: input.ids.length };
  }),
```

**Step 2: Add selection state and UI to Home.tsx**

Add state:

```tsx
const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
const [selectMode, setSelectMode] = useState(false);
```

Add delete mutation:

```tsx
const deleteManyMutation = trpc.sheetMusic.deleteMany.useMutation({
  onSuccess: (data) => {
    toast.success(`Deleted ${data.deleted} sheet(s)`);
    setSelectedIds(new Set());
    setSelectMode(false);
    utils.sheetMusic.list.invalidate();
  },
  onError: (err) => toast.error(err.message),
});
```

Add a "Select" toggle button next to the search bar. Add checkboxes to each card. Add a floating action bar when items are selected:

```tsx
{selectedIds.size > 0 && (
  <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 bg-background border shadow-lg rounded-lg p-3 flex items-center gap-3">
    <span className="text-sm font-medium">{selectedIds.size} selected</span>
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="destructive" size="sm">Delete selected</Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {selectedIds.size} sheet(s)?</AlertDialogTitle>
          <AlertDialogDescription>
            This will permanently delete the selected sheet music and all associated files.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => deleteManyMutation.mutate({ ids: Array.from(selectedIds) })}
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    <Button variant="ghost" size="sm" onClick={() => { setSelectedIds(new Set()); setSelectMode(false); }}>
      Cancel
    </Button>
  </div>
)}
```

**Step 3: Run `pnpm check`**

Run: `pnpm check`
Expected: PASS

**Step 4: Commit**

```bash
git add server/routers.ts client/src/pages/Home.tsx
git commit -m "feat: add bulk delete for sheet music on Home page"
```

---

## Summary

| Phase | Tasks | Items |
|-------|-------|-------|
| Phase 1 | Tasks 1-9 | Bug fixes + pipeline reliability |
| Phase 2 | Tasks 10-14 | CI build/lint + observability logging |
| Phase 3 | Tasks 15-19 | SSE, MIDI player UX, upload preview, bulk delete |

**Total:** 19 tasks (3 design items were consolidated into existing tasks, 1 was already implemented).

**After each phase:** Run `pnpm check && pnpm test` to verify no regressions.
