# Audiveris Pipeline Redesign

**Date:** 2026-03-05
**Scope:** Replace Gemini Vision OMR with Audiveris + AI refinement + human review/editing

---

## Overview

Replace the current single-shot Gemini Vision OMR pipeline with a 3-layer approach:

1. **Audiveris** (local, free) — produces raw MusicXML from PDF
2. **AI refinement** (Gemini, optional) — fixes voice separation, lyrics, ties/slurs
3. **Human review** (notation editor) — visual editor for correcting remaining errors

The app auto-completes to "ready" status. Human review is optional, accessed from a ready sheet.

---

## Pipeline Architecture

**Current:**
```
PDF → Gemini Vision (full OMR) → MusicXML → music21 analysis → MIDI → ready
```

**New:**
```
PDF → Audiveris CLI (local OMR) → raw MusicXML
    → AI targeted fixes (voice separation, lyrics, ties/slurs) [optional]
    → music21 analysis → MIDI generation → ready
    → user can review & edit notation, regenerate MIDI
```

### Key changes

- `process_pdf` calls Audiveris CLI instead of Gemini for raw OMR.
- New `refine_musicxml` step sends Audiveris output + PDF images to Gemini with a focused prompt fixing only voice assignments, lyrics, and ties/slurs.
- If no Gemini API key is configured, refinement is skipped — Audiveris output goes straight to music21.
- MusicXML uploads bypass Audiveris entirely (existing behavior, unchanged).
- No new DB statuses. Pipeline still goes `processing → ready` or `processing → error`.

---

## Audiveris Integration

### Installation

- Java 17 (OpenJDK) + Audiveris 5.x JAR installed via `deploy/setup.sh`.
- Audiveris JAR stored at `/opt/audiveris/`.
- Wrapper script at `/usr/local/bin/audiveris`: `java -jar /opt/audiveris/audiveris.jar "$@"`.
- Configured via `AUDIVERIS_CMD` env var (default: `audiveris`).

### Invocation

- `subprocess.run()` from Python service:
  ```
  audiveris -batch -export -output <temp_dir> <input.pdf>
  ```
- Audiveris writes `.mxl` (compressed MusicXML) to the output dir.
- Python extracts the `.mxl` and reads the MusicXML content.
- Timeout: 120s per PDF (kills subprocess if exceeded).
- If Audiveris fails or is not installed, PDF uploads go to "error" status with a clear message.

---

## AI Refinement Layer

### When it runs

After Audiveris produces MusicXML, before music21 analysis. Only if a Gemini API key is configured; otherwise skipped silently.

### What it fixes

Focused prompt — does NOT regenerate the entire score:

1. **Voice assignments** — ensure SATB parts are correctly separated based on stem direction
2. **Lyrics** — fix alignment of syllables to notes, fix hyphenation
3. **Ties and slurs** — add missing ones, remove spurious ones

Note pitches and rhythms are left unchanged (Audiveris is generally accurate there).

### Prompt

```
Here is a MusicXML file produced by automated OMR, and the original PDF score images.
Fix ONLY these issues — do not change note pitches or rhythms:
1. Voice assignments: ensure SATB parts are correctly separated based on stem direction
2. Lyrics: fix alignment of syllables to notes, fix hyphenation
3. Ties and slurs: add missing ones, remove spurious ones
Return the corrected MusicXML.
```

### Failure handling

If Gemini returns invalid XML or the call fails, fall back to the unrefined Audiveris output and log a warning. The pipeline continues.

### Cost impact

Much cheaper than current pipeline — AI patches an existing document rather than generating MusicXML from scratch.

---

## Human Review UI — Notation Editor

### Library

OpenSheetMusicDisplay (OSMD) — renders MusicXML as SVG in the browser. Free, open-source.

### Layout

- **Top:** toolbar with editing controls (select, pitch up/down, duration, delete, add note, undo/redo, save)
- **Left:** original PDF viewer (scrollable, zoomable)
- **Right:** OSMD-rendered score from the MusicXML (interactive)

### Editing capabilities (MVP)

| Action | Input | Behavior |
|--------|-------|----------|
| Select note | Click | Highlight selected note |
| Change pitch | Arrow keys up/down | Move note by semitone |
| Change duration | Number keys (1=whole, 2=half, 4=quarter, 8=eighth) | Change selected note duration |
| Delete note | Delete/Backspace | Replace note with equivalent rest |
| Add note | Click empty beat position | Insert note at clicked pitch |
| Undo/redo | Ctrl+Z / Ctrl+Y | Revert/reapply last edit |

### How edits work

- OSMD renders MusicXML and exposes note references back to source XML.
- Edits modify an in-memory MusicXML DOM (parsed via `DOMParser`).
- After each edit, OSMD re-renders from the updated DOM.
- "Save" sends modified MusicXML to server, which stores it and regenerates MIDI.

### Entry point

- SheetDetail page gets a "Review & Edit" button when status is "ready".
- Opens the editor view (same page, different mode — not a new route).
- Voice assignment controls remain available in the editor toolbar.

### New tRPC procedure

- `sheetMusic.updateMusicXML` — accepts edited MusicXML string, overwrites `musicxmlKey`, re-runs music21 analysis + MIDI generation.

---

## SSE Processing Steps

Updated events emitted during processing:

1. `"Running Audiveris OMR..."` — during subprocess execution
2. `"Refining with AI..."` — during Gemini refinement (skipped if no API key)
3. `"Analyzing voices..."` — existing music21 analysis
4. `"Generating MIDI files..."` — existing MIDI generation

---

## Deployment Changes

### `deploy/setup.sh`

- Install `openjdk-17-jre-headless`
- Download Audiveris 5.x release JAR to `/opt/audiveris/`
- Create wrapper script at `/usr/local/bin/audiveris`

### New env var

- `AUDIVERIS_CMD` — path to the audiveris command (default: `audiveris`)
- Added to `.env.template` and `ecosystem.config.cjs`

### Python service

- No new Python deps (subprocess call)
- `music_processor.py` — `process_pdf` rewritten, new `refine_musicxml` function

### Client

- New npm dep: `opensheetmusicdisplay`
- New component: `NotationEditor.tsx`
- `SheetDetail.tsx` — "Review & Edit" button + editor mode
- Vite: OSMD in its own chunk (like Tone.js, ~1MB)

### Database

No schema changes. Existing `musicxmlKey` stores MusicXML (original or edited).

---

## Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| Audiveris output quality on poor scans | Medium | AI refinement compensates; user can edit |
| OSMD editing interaction complexity | High | MVP scope limited to pitch/duration/delete/add |
| OSMD re-render performance on large scores | Medium | Debounce re-renders; only re-render affected page |
| Audiveris not available on VPS | Low | Clear error message; MusicXML uploads still work |
| AI refinement making things worse | Low | Validate output XML; fall back to raw Audiveris |
