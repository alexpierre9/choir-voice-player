# Choir Voice Player — Session Progress

> Last updated: 2026-02-23

---

## What Was Done This Session

### 1. Codebase Audit & Critical Bug Fixes
- **Added `bcryptjs` to `package.json`** — it was imported in routers.ts but missing from deps, silently crashing auth at runtime. Added `bcryptjs ^2.4.3` + `@types/bcryptjs ^2.4.6`.
- **Deleted `server/routers/stripe.ts`** — broken WIP file with 14 TypeScript errors (wrong imports, nonexistent schema tables, wrong Stripe API version). Was not integrated anywhere. `pnpm check` now passes cleanly (was: 17 errors → 0).

### 2. Python Service Fixes (`python_service/music_processor.py`)
- **PDF page limit** — Added `PDF_MAX_PAGES` cap (default 20) to avoid Gemini token limit / timeout on large PDFs. Configurable via `PDF_MAX_PAGES` env var.
- **Markdown XML cleanup** — Replaced fragile `split("```")` chain with `re.search(r"```(?:xml)?\s*([\s\S]*?)```")` — handles both ` ```xml ``` ` and ` ``` ``` ` fences robustly.
- **`flatten()` caching** — `analyze_musicxml` now calls `part.flatten()` once per part and reuses it for clef detection, pitch range analysis, and note count (was: 3 separate flatten calls).
- **All-OTHER MIDI fallback** — `generate_midi_files` now re-runs pitch/clef detection on parts that were assigned `OTHER` when no SATB voices exist. Previously this caused a silent failure where individual voice MIDIs were never created.
- **Voice assignment validation** — `generate_midi` endpoint now validates that all values in `voice_assignments` are known voice type strings, returning HTTP 400 for invalid input.
- **Cleanup** — Moved `import shutil` to module level; removed unused imports (`Path`, `PIL.Image`, `FileResponse`); collapsed `__exit__` params to `*_`.

### 3. Node.js getMidiUrl graceful fallback
- `getMidiUrl` in `server/routers.ts` now falls back to the `"all"` key if the specific voice MIDI wasn't generated, instead of throwing `"MIDI file for voice X not found"`.

### 4. Auth System Replacement
Replaced the email+password auth system (overkill for a single-user app) with a **simple env-based passphrase**.

**What changed:**
- `server/_core/env.ts` — Added `authPassphrase: process.env.AUTH_PASSPHRASE ?? ""`
- `server/routers.ts` — Removed `auth.register` procedure. Rewrote `auth.login` to accept `{ passphrase }`, compare with `crypto.timingSafeEqual` against `ENV.authPassphrase`, upsert a fixed `"owner"` user row on success.
- `server/db.ts` — Removed `getUserByEmail()`. Removed `OWNER_OPEN_ID`-based admin logic from `upsertUser`.
- `client/src/pages/Login.tsx` — Replaced email+password form with a single passphrase input.
- `client/src/pages/Register.tsx` — **Deleted**.
- `client/src/App.tsx` — Removed `/register` route.
- `client/src/components/Header.tsx` — Removed "Get started" button; only "Sign in" remains.

**To use:** Add `AUTH_PASSPHRASE=your-secret-here` to `.env`.

### 5. Database Cleanup
After the auth migration, the schema had leftover dead columns:
- `drizzle/schema.ts` — Removed `passwordHash` column, `emailUniqueIdx` constraint. Changed `SafeUser = Omit<User, "passwordHash">` → `SafeUser = User`. Removed unused `uniqueIndex`, `int` imports.
- `server/db.ts` — Removed `"passwordHash"` from `textFields` in `upsertUser`. Removed stale comments.
- `drizzle/0002_password_auth.sql` — **Deleted** (was an orphaned file not tracked in `_journal.json`, so Drizzle's migration runner never touched it anyway).
- `package.json` — Removed `bcryptjs` and `@types/bcryptjs` (no longer used anywhere).

---

## Current State

- `pnpm check` — **Passes cleanly (0 errors)**
- Auth — **Passphrase-based**, single user, no registration flow
- DB schema — **Clean**, no dead columns
- Python service — **Fixed**, more robust against edge cases
- Stripe code — **Removed**

---

## What's Left To Do (Recommended Improvements)

Ordered by impact. Pick up from any row.

### High Impact — ✅ ALL DONE

| # | Status | What | Notes |
|---|--------|------|-------|
| H1 | ✅ Done | **Pipeline step visibility** | `errorMessage` field carries step label during processing: "Reading score (OCR)…", "Storing score…", "Generating MIDI files…". SheetDetail shows it in the processing card. |
| H2 | ✅ Done | **Processing retry button** | `sheetMusic.retry` procedure re-reads `originalFileKey` from storage and re-runs the pipeline. Error state in SheetDetail now has a "Retry" button. |
| H3 | ✅ Done | **Home page: search** | Client-side filter by title/filename on the home sheet list. Shows all sheets (removed `.slice(0,6)` cap). |
| H4 | ✅ Done | **MIDI player: Solo button + Space shortcut** | Solo button ("S") per voice mutes all others. Space bar toggles play/pause (skipped when focus is in an input). |
| H5 | ✅ Done | **Voice assignment: Reset to auto-detected** | "Reset to auto-detected" button restores all assignments from `analysisResult.parts[i].detected_voice`. |
| H6 | ✅ Done | **MIDI file download** | Download icon button per voice in the player links to the MIDI URL with `download` attribute. |

### Medium Impact

| # | Status | What | Notes |
|---|--------|------|-------|
| M1 | ✅ Done | **Stale processing timeout** | `markStaleProcessingSheets()` in `server/db.ts`. Runs at startup + every 5 min. Marks any sheet in `"processing"` with `updatedAt` older than 5 min as `"error"`. |
| M2 | ✅ Done | **Startup env validation** | `validateEnv()` in `server/_core/env.ts` — exits with `[FATAL]` log if `JWT_SECRET`, `AUTH_PASSPHRASE`, or `DATABASE_URL` is missing. Called at the top of `startServer()`. |
| M3 | ⏳ Pending | **Upload progress indicator** | Base64 upload gives no progress. Use `XMLHttpRequest.onprogress` or switch to `FormData` with native fetch progress. Show upload % before "Processing..." kicks in. |
| M4 | ✅ Done | **System dark mode preference** | ThemeContext now checks `window.matchMedia('(prefers-color-scheme: dark)')` when no value is stored in localStorage. |
| M5 | ⏳ Pending | **Python SDK update** | `google-generativeai==0.3.1` is ~2 years old. Current SDK is `1.x` with different API. Update before Google deprecates old API. |
| M6 | ✅ Done | **Sheet title inline editing** | `sheetMusic.rename` tRPC procedure added. Click the title on SheetDetail to edit inline (Enter to save, Escape to cancel). |

### Lower Impact

| # | Status | What | Notes |
|---|--------|------|-------|
| L1 | ✅ Done | **Playback speed control** | 0.5×/0.75×/1×/1.25×/1.5× buttons. Parts rebuilt with scaled note times on change. |
| L2 | ✅ Done | **SATB voice color coding** | `client/src/lib/voiceColors.ts` — soprano=pink, alto=purple, tenor=blue, bass=green. Applied in SheetDetail cards and MidiPlayer voice rows. |
| L3 | ✅ Done | **Error boundary polish** | Friendly message; stack trace hidden behind "Show technical details" collapsible toggle. |
| L4 | ⏳ Pending | **CI / pre-push type check** | Add a pre-push git hook or GitHub Actions workflow that runs `pnpm check` + `pnpm test`. |
| L5 | ✅ Done | **Keyboard accessibility** | Space = play/pause, ArrowLeft/Right = seek ±5s, M = mute first voice. Skipped when focus is in an input. |

---

## Key Files Reference

| Area | File |
|------|------|
| tRPC router (all API) | `server/routers.ts` |
| Auth / JWT | `server/_core/sdk.ts` |
| Environment vars | `server/_core/env.ts` |
| DB queries | `server/db.ts` |
| DB schema + types | `drizzle/schema.ts` |
| Python service | `python_service/music_processor.py` |
| Home page | `client/src/pages/Home.tsx` |
| Upload page | `client/src/pages/Upload.tsx` |
| Sheet detail + voice UI | `client/src/pages/SheetDetail.tsx` |
| MIDI player component | `client/src/components/MidiPlayer.tsx` |
| Auth hook | `client/src/_core/hooks/useAuth.ts` |
| App routes | `client/src/App.tsx` |
| Theme context | `client/src/contexts/ThemeContext.tsx` |

## Required `.env` Variables

```env
DATABASE_URL=mysql://user:pass@localhost:3306/choir
JWT_SECRET=<long-random-string>
AUTH_PASSPHRASE=<your-login-passphrase>
GEMINI_API_KEY=<google-ai-key>

# Optional
PYTHON_SERVICE_URL=http://localhost:8001
LOCAL_STORAGE_DIR=/var/lib/choir-files
PUBLIC_URL_BASE=/files
VITE_APP_TITLE=Choir Voice Player
```
