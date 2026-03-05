# App Improvements Design

**Date:** 2026-03-04
**Scope:** Bug fixes, pipeline reliability, CI/observability, UX improvements

---

## Phase 1: Bug Fixes & Reliability

### 1.1 Client Bug Fixes

| # | Issue | File | Fix |
|---|-------|------|-----|
| 1 | Sequential MIDI URL fetches | `client/src/pages/SheetDetail.tsx:157` | Wrap voice URL fetches in `Promise.allSettled()` instead of sequential loop |
| 2 | Silent MIDI load failures | `SheetDetail.tsx` + `MidiPlayer.tsx` | Surface partial-load warning via toast when some voices fail to load |
| 3 | Settings initialization race | `client/src/pages/Settings.tsx:26-30` | Move config initialization to `useEffect` with `[config, initialized]` deps |
| 4 | Hardcoded MIDI download names | `client/src/components/MidiPlayer.tsx:522` | Accept `sheetTitle` prop, prefix filenames: `{sheetTitle}-{voice}.mid` |
| 5 | Stale footer year | `client/src/pages/Home.tsx:279` | Replace `2025` with `new Date().getFullYear()` |
| 6 | Voice assignment save error silent | `client/src/pages/SheetDetail.tsx` | Add `onError` callback to `updateVoiceAssignments` mutation with toast |

### 1.2 Pipeline Reliability

| # | Issue | File | Fix |
|---|-------|------|-----|
| 7 | No music21 parsing timeout | `python_service/music_processor.py` | Wrap `analyze_musicxml` call in `asyncio.wait_for(timeout=60)` |
| 8 | No MIDI file size validation | `python_service/music_processor.py` | Check `len(midi_bytes) > 0` before base64-encoding and returning |
| 9 | Silent PDF truncation | `python_service/music_processor.py` | Return `warnings: ["PDF truncated from N to 20 pages"]` in response; surface warning in SheetDetail processing UI |
| 10 | Gemini model not validated on save | `python_service/music_processor.py` | In `/api/update-config`, validate model name by calling `genai.get_model()` before accepting the change |

---

## Phase 2: CI & Observability

### 2.1 CI Pipeline

| # | Issue | Fix |
|---|-------|-----|
| 11 | CI doesn't verify build | Add `pnpm build` step to `.github/workflows/ci.yml` after type-check |
| 12 | No linting | Add ESLint with minimal config: `@typescript-eslint/recommended` + `react-hooks/recommended`. Add `pnpm lint` script and CI step. |

### 2.2 Server Observability

| # | Issue | Fix |
|---|-------|-----|
| 13 | No upload request logging | Log `{ filename, fileType, sizeBytes, userId }` at start of upload handler in `server/routers.ts` |
| 14 | No Python service latency tracking | Add `startTime` / `durationMs` logging around each Python service fetch in `processSheetMusicAsync()` |
| 15 | No voice assignment audit trail | Log `{ sheetId, oldAssignments, newAssignments }` in `updateVoiceAssignments` handler |

---

## Phase 3: UX Improvements

### 3.1 Real-time Processing Updates (SSE)

**Current:** Client polls `sheetMusic.get` every 3s while status is "processing".

**New:** Add `GET /api/sse/sheet/:id` endpoint using Express SSE.

**Architecture:**
- Express handler: `res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' })`
- In-memory `EventEmitter` keyed by `sheetId` in `server/routers.ts`
- `processSheetMusicAsync` emits events at each pipeline step:
  - `processing_step` (e.g., "Analyzing PDF...", "Detecting voices...", "Generating MIDI...")
  - `status_changed` with new status
  - `ready` with final data
  - `error` with error message
- Client: `SheetDetail.tsx` subscribes via `EventSource` when status is "processing"
- Fallback: If SSE connection drops, falls back to 3s polling (existing behavior)
- Auth: SSE endpoint is protected; reads JWT from cookie (same as tRPC)
- Cleanup: Remove listener on `res.close` event

**Events format:**
```
event: processing_step
data: {"step": "Analyzing PDF with Gemini Vision..."}

event: status_changed
data: {"status": "ready"}
```

### 3.2 MIDI Player UX

| # | Feature | Design |
|---|---------|--------|
| 17 | Per-voice keyboard shortcuts | Keys `1`-`4` toggle mute for voices 1-4. Show shortcut hint in tooltip on volume controls. Only active when MidiPlayer is in viewport (use `document.activeElement` check or focus trap). |
| 18 | Visual mute indicators | Muted voices: `opacity-40` + strikethrough on label text. Currently only icon changes. |
| 19 | Sheet title in download filenames | Sanitize title: replace `[^a-zA-Z0-9-_ ]` with empty, trim, replace spaces with `-`. Result: `my-song-soprano.mid`. Pass `sheetTitle` prop from SheetDetail to MidiPlayer. |

### 3.3 Upload & Home Page

| # | Feature | Design |
|---|---------|--------|
| 20 | File type badge before upload | After file selection, show badge with PDF icon or MusicXML icon + file size. Use existing `Badge` component from shadcn/ui with `variant="secondary"`. |
| 21 | Dynamic skeleton count | Use `placeholderData: previousData` in tRPC query options. Skeleton count = `previousData?.length ?? 3`. |
| 22 | Bulk delete on Home page | Add checkbox overlay on each sheet card (visible on hover, always visible when any selected). When 1+ selected, show floating action bar at bottom with "Delete N selected" button. Confirmation via `AlertDialog`. New tRPC mutation `sheetMusic.deleteMany` accepting `ids: string[]`. |

**Bulk delete implementation notes:**
- State: `selectedIds: Set<string>` in Home.tsx
- Select all / deselect all toggle
- `deleteMany` mutation: loop `deleteSheetMusic()` + storage cleanup in parallel with `Promise.allSettled()`
- Invalidate `sheetMusic.list` query on success
- Show toast with count of deleted sheets

---

## Implementation Order

1. **Phase 1** (bug fixes) — all items are independent, can be parallelized
2. **Phase 2** (CI/observability) — do CI first (#11-12), then logging (#13-15)
3. **Phase 3** (UX) — do SSE (#16) first as it's the most complex, then MIDI player (#17-19), then Home/Upload (#20-22)

## Testing Strategy

- Phase 1: Manual testing of each fix + add Vitest unit tests where applicable (Settings init, MIDI filename sanitization)
- Phase 2: CI changes are self-testing; logging verified via dev server output
- Phase 3: Manual E2E testing; SSE tested with `curl` + browser dev tools; bulk delete tested with multiple sheets

## Risk Assessment

| Item | Risk | Mitigation |
|------|------|------------|
| SSE (#16) | Complexity, connection management | Polling fallback; simple EventEmitter (no Redis) |
| Bulk delete (#22) | Partial failure (some sheets delete, some fail) | `Promise.allSettled()` + report partial results |
| ESLint (#12) | Many existing warnings on first run | Start with `--max-warnings` or fix incrementally |
| music21 timeout (#7) | May kill legitimate long parses | 60s is generous; log timeouts for tuning |
