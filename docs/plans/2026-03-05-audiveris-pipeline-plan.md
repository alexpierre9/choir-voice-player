# Audiveris Pipeline Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace Gemini Vision OMR with a 3-layer pipeline: Audiveris (local OMR) → AI refinement (targeted voice/lyrics/ties fixes) → human review (visual notation editor with OSMD).

**Architecture:** Audiveris CLI subprocess produces raw MusicXML from PDF. An optional AI refinement step patches voice assignments, lyrics, and ties/slurs using the existing Gemini API. The client gains a notation editor (OpenSheetMusicDisplay) for correcting notes in-browser. A new `updateMusicXML` tRPC procedure stores edits and regenerates MIDI.

**Tech Stack:** Audiveris 5.x (Java CLI), OpenSheetMusicDisplay (npm), existing Gemini API, music21, FastAPI, React, tRPC.

**Design doc:** `docs/plans/2026-03-05-audiveris-pipeline-design.md`

---

## Task 1: Add Audiveris to deployment scripts

**Files:**
- Modify: `deploy/setup.sh`
- Modify: `deploy/.env.template`
- Modify: `ecosystem.config.cjs`

**Step 1: Update `deploy/setup.sh`**

After the Python 3.11 install block (around line 36), add:

```bash
# Java 17 + Audiveris OMR engine
echo -e "${GREEN}Installing Java 17 and Audiveris...${NC}"
apt install -y openjdk-17-jre-headless

# Download Audiveris release
AUDIVERIS_VERSION="5.4"
AUDIVERIS_DIR="/opt/audiveris"
mkdir -p "$AUDIVERIS_DIR"
if [ ! -f "$AUDIVERIS_DIR/audiveris.jar" ]; then
    curl -fsSL "https://github.com/Audiveris/audiveris/releases/download/$AUDIVERIS_VERSION/Audiveris-$AUDIVERIS_VERSION.jar" \
        -o "$AUDIVERIS_DIR/audiveris.jar"
fi

# Create wrapper script
cat > /usr/local/bin/audiveris << 'WRAPPER'
#!/bin/bash
java -jar /opt/audiveris/audiveris.jar "$@"
WRAPPER
chmod +x /usr/local/bin/audiveris
echo "Audiveris installed at /usr/local/bin/audiveris"
```

**Step 2: Add `AUDIVERIS_CMD` to `.env.template`**

```
# Audiveris OMR (path to audiveris CLI, default: "audiveris")
AUDIVERIS_CMD=audiveris
```

**Step 3: Forward env var in `ecosystem.config.cjs`**

In the `choir-omr-service` env block (around line 28), add:

```javascript
AUDIVERIS_CMD: process.env.AUDIVERIS_CMD || "audiveris",
```

**Step 4: Commit**

```bash
git add deploy/setup.sh deploy/.env.template ecosystem.config.cjs
git commit -m "feat: add Audiveris installation to deployment scripts"
```

---

## Task 2: Rewrite `process_pdf` to use Audiveris CLI

**Files:**
- Modify: `python_service/music_processor.py:189-428` (replace `process_pdf` method)

**Step 1: Add Audiveris subprocess helper**

At the top of the `MusicProcessor` class (after `__init__`, around line 170), add a method:

```python
def _run_audiveris(self, pdf_path: str) -> str:
    """
    Run Audiveris CLI to convert PDF to MusicXML.
    Returns path to the output MusicXML file.
    """
    audiveris_cmd = os.environ.get("AUDIVERIS_CMD", "audiveris")
    output_dir = os.path.join(self.temp_dir, "audiveris_output")
    os.makedirs(output_dir, exist_ok=True)

    cmd = [audiveris_cmd, "-batch", "-export", "-output", output_dir, pdf_path]
    logger.info("Running Audiveris: %s", " ".join(cmd))

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=120,
        )
    except FileNotFoundError:
        raise RuntimeError(
            "Audiveris is not installed. Install Java 17 and Audiveris, "
            "or set AUDIVERIS_CMD to the correct path."
        )
    except subprocess.TimeoutExpired:
        raise RuntimeError("Audiveris timed out after 120 seconds")

    if result.returncode != 0:
        logger.error("Audiveris stderr: %s", result.stderr)
        raise RuntimeError(f"Audiveris failed (exit {result.returncode}): {result.stderr[:500]}")

    # Audiveris outputs .mxl (compressed MusicXML) files
    mxl_files = [f for f in os.listdir(output_dir) if f.endswith(".mxl")]
    if not mxl_files:
        # Also check for .xml files
        xml_files = [f for f in os.listdir(output_dir) if f.endswith(".xml")]
        if xml_files:
            return os.path.join(output_dir, xml_files[0])
        raise RuntimeError("Audiveris produced no output files")

    # Extract .mxl (ZIP containing MusicXML)
    mxl_path = os.path.join(output_dir, mxl_files[0])
    import zipfile
    with zipfile.ZipFile(mxl_path, "r") as zf:
        xml_names = [n for n in zf.namelist() if n.endswith(".xml") and not n.startswith("META-INF")]
        if not xml_names:
            raise RuntimeError("Audiveris .mxl contains no XML files")
        extracted_path = os.path.join(output_dir, "score.xml")
        with open(extracted_path, "wb") as out:
            out.write(zf.read(xml_names[0]))

    return extracted_path
```

**Step 2: Add `import subprocess` at the top of the file** (around line 10)

```python
import subprocess
import zipfile
```

**Step 3: Rewrite `process_pdf` method**

Replace the existing `process_pdf` method (lines 189–428) with:

```python
def process_pdf(self, pdf_path: str) -> str:
    """
    Convert PDF to MusicXML using Audiveris OMR.
    Returns path to generated MusicXML file.
    """
    if not os.path.exists(pdf_path):
        raise ValueError(f"PDF file not found: {pdf_path}")
    if not os.path.isfile(pdf_path):
        raise ValueError(f"Path is not a file: {pdf_path}")
    if not pdf_path.lower().endswith('.pdf'):
        raise ValueError(f"File must be a PDF: {pdf_path}")

    # Count pages for warnings
    doc = fitz.open(pdf_path)
    total_pages = len(doc)
    doc.close()

    if total_pages == 0:
        raise ValueError("Could not extract pages from PDF")

    warnings = []
    if total_pages > PDF_MAX_PAGES:
        warnings.append(f"PDF has {total_pages} pages; only first {PDF_MAX_PAGES} will be processed")

    # Step 1: Run Audiveris
    musicxml_path = self._run_audiveris(pdf_path)
    logger.info("Audiveris produced MusicXML: %s", musicxml_path)

    # Step 2: AI refinement (optional — only if Gemini API key is set)
    if GENAI_CLIENT is not None:
        try:
            musicxml_path = self._refine_musicxml(musicxml_path, pdf_path)
            logger.info("AI refinement completed")
        except Exception as e:
            logger.warning("AI refinement failed, using raw Audiveris output: %s", e)
    else:
        logger.info("No Gemini API key configured — skipping AI refinement")

    # Store warnings for the caller
    self._pdf_warnings = warnings
    return musicxml_path
```

**Step 4: Keep the old `process_pdf` as `_process_pdf_gemini` for reference/fallback**

Rename the old method body to `_process_pdf_gemini` so it's preserved but not called by default. This is optional and can be deleted later.

**Step 5: Commit**

```bash
git add python_service/music_processor.py
git commit -m "feat: replace Gemini Vision OMR with Audiveris CLI in process_pdf"
```

---

## Task 3: Implement AI refinement step

**Files:**
- Modify: `python_service/music_processor.py` (add `_refine_musicxml` method to `MusicProcessor`)

**Step 1: Add `_refine_musicxml` method**

Add after the `_run_audiveris` method:

```python
def _refine_musicxml(self, musicxml_path: str, pdf_path: str) -> str:
    """
    Use Gemini AI to fix voice assignments, lyrics, and ties/slurs
    in the Audiveris-produced MusicXML.
    Returns path to the refined MusicXML file.
    """
    if GENAI_CLIENT is None:
        return musicxml_path

    # Read the Audiveris MusicXML
    with open(musicxml_path, "r", encoding="utf-8") as f:
        musicxml_text = f.read()

    # Render PDF pages to JPEG for AI reference
    scale = PDF_RENDER_DPI / 72.0
    mat = fitz.Matrix(scale, scale)
    doc = fitz.open(pdf_path)
    page_limit = min(len(doc), PDF_MAX_PAGES)

    jpeg_pages = []
    for i in range(page_limit):
        pix = doc[i].get_pixmap(matrix=mat)
        jpeg_pages.append(pix.tobytes("jpeg", jpg_quality=80))
    doc.close()

    # Build prompt
    prompt = """You are an expert music engraver reviewing an automated OMR (Audiveris) output.

Below is the MusicXML produced by Audiveris. The original PDF score images are also attached.

Fix ONLY these categories of errors — do NOT change note pitches or rhythms:

1. **Voice assignments (SATB):** Ensure parts are correctly labeled and separated.
   In short-score format, stem-up on treble = Soprano, stem-down = Alto,
   stem-up on bass = Tenor, stem-down = Bass.
2. **Lyrics:** Fix syllable-to-note alignment. Fix hyphenation between syllables.
3. **Ties and slurs:** Add missing ties/slurs visible in the PDF. Remove spurious ones.

Return the complete corrected MusicXML. Output ONLY valid XML, no markdown fences.

=== AUDIVERIS OUTPUT ===
""" + musicxml_text

    # Build content parts: prompt text + JPEG images
    contents = [prompt]
    for jpeg in jpeg_pages:
        contents.append(genai_types.Part.from_bytes(data=jpeg, mime_type="image/jpeg"))

    model_name = _config.get("gemini_model_name", "gemini-2.0-flash")
    max_tokens = int(_config.get("gemini_max_output_tokens", 8192))

    response = GENAI_CLIENT.models.generate_content(
        model=model_name,
        contents=contents,
        config=genai_types.GenerateContentConfig(
            max_output_tokens=max_tokens,
            temperature=0.1,
        ),
    )

    refined_xml = response.text.strip()

    # Strip markdown fences if present
    if refined_xml.startswith("```"):
        lines = refined_xml.split("\n")
        lines = lines[1:]  # Remove opening fence
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        refined_xml = "\n".join(lines)

    # Validate that the output is parseable XML
    import xml.etree.ElementTree as ET
    try:
        ET.fromstring(refined_xml)
    except ET.ParseError as e:
        logger.warning("AI returned invalid XML, falling back to Audiveris output: %s", e)
        return musicxml_path

    # Write refined MusicXML
    refined_path = os.path.join(self.temp_dir, "refined_score.xml")
    with open(refined_path, "w", encoding="utf-8") as f:
        f.write(refined_xml)

    return refined_path
```

**Step 2: Commit**

```bash
git add python_service/music_processor.py
git commit -m "feat: add AI refinement step for Audiveris MusicXML output"
```

---

## Task 4: Update `/api/process-pdf` endpoint for new pipeline

**Files:**
- Modify: `python_service/music_processor.py:872-924` (the `process_pdf` FastAPI handler)

**Step 1: Update the endpoint handler**

The endpoint handler currently calls `processor.process_pdf()` and then `processor.analyze_musicxml()`. Update it to also pass back warnings from Audiveris and handle the new flow. The handler structure stays the same — the pipeline changes are inside `process_pdf()`. The main change is plumbing the `_pdf_warnings` attribute:

In the `_run` function inside the endpoint (around line 900), after `musicxml_path = processor.process_pdf(pdf_path)`, add:

```python
warnings = getattr(processor, '_pdf_warnings', [])
```

And merge these warnings into the response dict at the end (around line 918):

```python
result["warnings"] = warnings
```

**Step 2: Commit**

```bash
git add python_service/music_processor.py
git commit -m "feat: plumb Audiveris warnings through process-pdf endpoint"
```

---

## Task 5: Update SSE events in `processSheetMusicAsync`

**Files:**
- Modify: `server/routers.ts:664-769`

**Step 1: Update processing step messages**

In `processSheetMusicAsync` (around line 675), change the SSE event messages to reflect the new pipeline:

```typescript
// Before calling Python service
emitProcessingEvent(sheetId, "processing_step", { step: "Running Audiveris OMR..." });
```

The Python service internally handles Audiveris + AI refinement, so from the Node side this is still one call. But we can emit a second event after the PDF processing call returns:

```typescript
// After PDF processing returns successfully
emitProcessingEvent(sheetId, "processing_step", { step: "Analyzing voices..." });
```

The existing step messages for MIDI generation remain unchanged.

**Step 2: Commit**

```bash
git add server/routers.ts
git commit -m "feat: update SSE step messages for Audiveris pipeline"
```

---

## Task 6: Add `updateMusicXML` tRPC procedure

**Files:**
- Modify: `server/routers.ts` (add new procedure to `sheetMusic` router)

**Step 1: Add the procedure**

After the existing `updateVoiceAssignments` procedure (around line 274), add:

```typescript
updateMusicXML: protectedProcedure
  .input(z.object({
    id: z.string().min(1).max(64),
    musicxml: z.string().min(1),
  }))
  .mutation(async ({ input, ctx }) => {
    const sheet = await db
      .select()
      .from(sheetMusicTable)
      .where(eq(sheetMusicTable.id, input.id))
      .limit(1);

    if (!sheet.length) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Sheet not found" });
    }
    if (sheet[0].userId !== ctx.user.id) {
      throw new TRPCError({ code: "FORBIDDEN", message: "Not your sheet" });
    }

    const sheetId = input.id;
    const userId = ctx.user.id;

    // Store updated MusicXML
    const musicxmlKey = `sheet-music/${userId}/${sheetId}/score.musicxml`;
    const musicxmlBuffer = Buffer.from(input.musicxml, "utf-8");
    await storage.put(musicxmlKey, musicxmlBuffer);

    // Re-run analysis via Python service
    emitProcessingEvent(sheetId, "processing_step", { step: "Re-analyzing edited score..." });

    await db
      .update(sheetMusicTable)
      .set({
        status: "processing",
        musicxmlKey,
        errorMessage: null,
        midiFileKeys: null,
      })
      .where(eq(sheetMusicTable.id, sheetId));

    // Send MusicXML to Python for re-analysis
    const formData = new FormData();
    formData.append("file", new Blob([musicxmlBuffer]), "score.musicxml");

    const pyUrl = `${PYTHON_SERVICE_URL}/api/process-musicxml`;
    const headers: Record<string, string> = {};
    if (INTERNAL_TOKEN) headers[INTERNAL_TOKEN_HEADER] = INTERNAL_TOKEN;

    const startTime = Date.now();
    const pyRes = await fetch(pyUrl, {
      method: "POST",
      body: formData,
      headers,
      signal: AbortSignal.timeout(60_000),
    });
    logger.info({ endpoint: "/api/process-musicxml", durationMs: Date.now() - startTime, status: pyRes.status }, "Python service call");

    if (!pyRes.ok) {
      const errMsg = await parsePythonError(pyRes);
      await db.update(sheetMusicTable).set({ status: "error", errorMessage: errMsg }).where(eq(sheetMusicTable.id, sheetId));
      emitProcessingEvent(sheetId, "status_changed", { status: "error", errorMessage: errMsg });
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: errMsg });
    }

    const result = await pyRes.json();
    const analysis = result.analysis;

    // Build voice assignments from analysis
    const voiceAssignments: Record<string, string> = {};
    if (analysis?.parts) {
      for (const part of analysis.parts) {
        voiceAssignments[String(part.index)] = part.detected_voice || "other";
      }
    }

    await db
      .update(sheetMusicTable)
      .set({
        musicxmlKey,
        analysisResult: { ...analysis, warnings: result.warnings || [] },
        voiceAssignments,
      })
      .where(eq(sheetMusicTable.id, sheetId));

    // Regenerate MIDI
    emitProcessingEvent(sheetId, "processing_step", { step: "Generating MIDI files..." });
    await enqueueMidiRegeneration(sheetId, userId);

    return { success: true };
  }),
```

**Step 2: Update CLAUDE.md**

Add `.updateMusicXML` to the tRPC procedures list.

**Step 3: Commit**

```bash
git add server/routers.ts CLAUDE.md
git commit -m "feat: add updateMusicXML tRPC procedure for notation editor saves"
```

---

## Task 7: Install OpenSheetMusicDisplay and add Vite chunk

**Files:**
- Modify: `package.json` (new dependency)
- Modify: `vite.config.ts:23-29` (add OSMD chunk)

**Step 1: Install OSMD**

```bash
pnpm add opensheetmusicdisplay
```

**Step 2: Add OSMD to `manualChunks` in `vite.config.ts`**

In the `manualChunks` block (line 24), add:

```typescript
manualChunks: {
  "tone": ["tone", "@tonejs/midi"],
  "osmd": ["opensheetmusicdisplay"],
  "vendor": ["react", "react-dom", "@tanstack/react-query", "@trpc/client", "superjson"],
}
```

**Step 3: Commit**

```bash
git add package.json pnpm-lock.yaml vite.config.ts
git commit -m "feat: add OpenSheetMusicDisplay dependency with code splitting"
```

---

## Task 8: Create `NotationEditor` component

**Files:**
- Create: `client/src/components/NotationEditor.tsx`

This is the largest task. The component has three parts: toolbar, PDF viewer, and OSMD score with editing.

**Step 1: Create the component file**

```tsx
import { useRef, useState, useEffect, useCallback } from "react";
import { OpenSheetMusicDisplay as OSMD } from "opensheetmusicdisplay";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  ArrowUp, ArrowDown, Trash2, Undo2, Redo2, Save, Loader2, MousePointer,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface NotationEditorProps {
  musicxml: string;
  pdfUrl: string | null;
  onSave: (musicxml: string) => void;
  isSaving?: boolean;
  className?: string;
}

interface EditAction {
  before: string; // MusicXML state before the edit
  after: string;  // MusicXML state after the edit
}

// Duration labels for number key shortcuts
const DURATION_MAP: Record<string, { label: string; type: string }> = {
  "1": { label: "Whole", type: "whole" },
  "2": { label: "Half", type: "half" },
  "4": { label: "Quarter", type: "quarter" },
  "8": { label: "Eighth", type: "eighth" },
};

export default function NotationEditor({
  musicxml,
  pdfUrl,
  onSave,
  isSaving = false,
  className,
}: NotationEditorProps) {
  const osmdContainerRef = useRef<HTMLDivElement>(null);
  const osmdRef = useRef<OSMD | null>(null);
  const [currentXml, setCurrentXml] = useState(musicxml);
  const [undoStack, setUndoStack] = useState<EditAction[]>([]);
  const [redoStack, setRedoStack] = useState<EditAction[]>([]);
  const [selectedNoteInfo, setSelectedNoteInfo] = useState<string | null>(null);
  const [isRendering, setIsRendering] = useState(true);
  const [hasChanges, setHasChanges] = useState(false);

  // Initialize OSMD
  useEffect(() => {
    if (!osmdContainerRef.current) return;

    const osmd = new OSMD(osmdContainerRef.current, {
      autoResize: true,
      drawTitle: true,
      drawComposer: true,
    });
    osmdRef.current = osmd;

    osmd.load(currentXml).then(() => {
      osmd.render();
      setIsRendering(false);
    });

    return () => {
      osmd.clear();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-render when XML changes (from edits)
  const renderXml = useCallback(async (xml: string) => {
    const osmd = osmdRef.current;
    if (!osmd) return;
    setIsRendering(true);
    try {
      await osmd.load(xml);
      osmd.render();
    } catch (e) {
      console.error("OSMD render error:", e);
    }
    setIsRendering(false);
  }, []);

  // Apply an edit to the MusicXML DOM
  const applyEdit = useCallback((editFn: (doc: Document) => boolean) => {
    const parser = new DOMParser();
    const doc = parser.parseFromString(currentXml, "application/xml");

    const parserError = doc.querySelector("parsererror");
    if (parserError) return;

    const changed = editFn(doc);
    if (!changed) return;

    const serializer = new XMLSerializer();
    const newXml = serializer.serializeToString(doc);

    setUndoStack((prev) => [...prev, { before: currentXml, after: newXml }]);
    setRedoStack([]);
    setCurrentXml(newXml);
    setHasChanges(true);
    renderXml(newXml);
  }, [currentXml, renderXml]);

  // Undo
  const handleUndo = useCallback(() => {
    setUndoStack((prev) => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1];
      setRedoStack((r) => [...r, last]);
      setCurrentXml(last.before);
      setHasChanges(true);
      renderXml(last.before);
      return prev.slice(0, -1);
    });
  }, [renderXml]);

  // Redo
  const handleRedo = useCallback(() => {
    setRedoStack((prev) => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1];
      setUndoStack((u) => [...u, last]);
      setCurrentXml(last.after);
      setHasChanges(true);
      renderXml(last.after);
      return prev.slice(0, -1);
    });
  }, [renderXml]);

  // Keyboard shortcuts
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.ctrlKey && e.key === "z") {
        e.preventDefault();
        handleUndo();
      } else if (e.ctrlKey && e.key === "y") {
        e.preventDefault();
        handleRedo();
      } else if (e.ctrlKey && e.key === "s") {
        e.preventDefault();
        if (hasChanges && !isSaving) onSave(currentXml);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleUndo, handleRedo, hasChanges, isSaving, currentXml, onSave]);

  return (
    <div className={cn("flex flex-col h-full", className)}>
      {/* Toolbar */}
      <div className="flex items-center gap-1 p-2 border-b bg-muted/50">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" disabled>
              <MousePointer className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Select (click notes in score)</TooltipContent>
        </Tooltip>

        <Separator orientation="vertical" className="h-6 mx-1" />

        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" onClick={handleUndo} disabled={undoStack.length === 0}>
              <Undo2 className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Undo <kbd className="ml-1 text-xs">Ctrl+Z</kbd></TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" onClick={handleRedo} disabled={redoStack.length === 0}>
              <Redo2 className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Redo <kbd className="ml-1 text-xs">Ctrl+Y</kbd></TooltipContent>
        </Tooltip>

        <Separator orientation="vertical" className="h-6 mx-1" />

        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" disabled={!selectedNoteInfo}>
              <ArrowUp className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Pitch up <kbd className="ml-1 text-xs">↑</kbd></TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" disabled={!selectedNoteInfo}>
              <ArrowDown className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Pitch down <kbd className="ml-1 text-xs">↓</kbd></TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" disabled={!selectedNoteInfo}>
              <Trash2 className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Delete note <kbd className="ml-1 text-xs">Del</kbd></TooltipContent>
        </Tooltip>

        <Separator orientation="vertical" className="h-6 mx-1" />

        {Object.entries(DURATION_MAP).map(([key, { label }]) => (
          <Tooltip key={key}>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" disabled={!selectedNoteInfo} className="text-xs font-mono w-7">
                {key}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{label} note <kbd className="ml-1 text-xs">{key}</kbd></TooltipContent>
          </Tooltip>
        ))}

        <div className="flex-1" />

        {selectedNoteInfo && (
          <span className="text-xs text-muted-foreground mr-2">{selectedNoteInfo}</span>
        )}

        <Button
          size="sm"
          onClick={() => onSave(currentXml)}
          disabled={!hasChanges || isSaving}
        >
          {isSaving ? (
            <Loader2 className="h-4 w-4 mr-1 animate-spin" />
          ) : (
            <Save className="h-4 w-4 mr-1" />
          )}
          Save
        </Button>
      </div>

      {/* Editor area */}
      <div className="flex-1 flex min-h-0">
        {/* PDF viewer (left) */}
        {pdfUrl && (
          <div className="w-1/2 border-r overflow-auto bg-gray-50 dark:bg-gray-900">
            <iframe
              src={pdfUrl}
              className="w-full h-full"
              title="Original PDF"
            />
          </div>
        )}

        {/* OSMD rendered score (right) */}
        <div className={cn("overflow-auto p-4 bg-white dark:bg-gray-950", pdfUrl ? "w-1/2" : "w-full")}>
          {isRendering && (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          )}
          <div ref={osmdContainerRef} />
        </div>
      </div>
    </div>
  );
}
```

**Note:** This is the MVP scaffold. The click-to-select-note interaction requires OSMD cursor/note-click APIs which need iterative development against the actual rendered output. The `applyEdit` infrastructure and undo/redo are fully functional. Note selection and pitch/duration edits will be wired in Task 9.

**Step 2: Commit**

```bash
git add client/src/components/NotationEditor.tsx
git commit -m "feat: add NotationEditor component with OSMD, toolbar, undo/redo"
```

---

## Task 9: Wire up note selection and editing in NotationEditor

**Files:**
- Modify: `client/src/components/NotationEditor.tsx`

**Step 1: Add click-to-select interaction**

After OSMD renders, attach click handlers to the SVG note elements. OSMD renders notes as SVG `<g>` groups with class `vf-stavenote`. Each note element can be mapped back to its MusicXML `<note>` via OSMD's internal data structures.

Add after the OSMD render in the `useEffect`:

```typescript
// After osmd.render(), attach click handlers
const svgNotes = osmdContainerRef.current?.querySelectorAll(".vf-stavenote");
svgNotes?.forEach((el, idx) => {
  (el as SVGElement).style.cursor = "pointer";
  el.addEventListener("click", () => {
    // Highlight selected note
    svgNotes.forEach((n) => (n as SVGElement).classList.remove("note-selected"));
    (el as SVGElement).classList.add("note-selected");
    setSelectedNoteInfo(`Note ${idx + 1}`);
    // Store index for editing operations
    selectedNoteIndexRef.current = idx;
  });
});
```

**Step 2: Add CSS for selected note highlight**

In `client/src/index.css`, add:

```css
.note-selected {
  filter: drop-shadow(0 0 4px var(--primary));
}
.note-selected .vf-notehead path {
  fill: var(--primary);
}
```

**Step 3: Implement pitch change**

The pitch change function modifies the MusicXML `<note>` element's `<pitch>` child:

```typescript
function changePitch(doc: Document, noteIndex: number, semitones: number): boolean {
  const notes = doc.querySelectorAll("note");
  // Filter out rest elements
  const pitchedNotes = Array.from(notes).filter((n) => n.querySelector("pitch"));
  if (noteIndex >= pitchedNotes.length) return false;

  const note = pitchedNotes[noteIndex];
  const pitch = note.querySelector("pitch");
  if (!pitch) return false;

  const stepEl = pitch.querySelector("step");
  const octaveEl = pitch.querySelector("octave");
  const alterEl = pitch.querySelector("alter");
  if (!stepEl || !octaveEl) return false;

  const STEPS = ["C", "D", "E", "F", "G", "A", "B"];
  const SEMITONES = [0, 2, 4, 5, 7, 9, 11];

  const step = stepEl.textContent || "C";
  const octave = parseInt(octaveEl.textContent || "4");
  const alter = alterEl ? parseInt(alterEl.textContent || "0") : 0;

  const stepIdx = STEPS.indexOf(step);
  const currentMidi = (octave + 1) * 12 + SEMITONES[stepIdx] + alter;
  const newMidi = currentMidi + semitones;

  const newOctave = Math.floor(newMidi / 12) - 1;
  const chromatic = newMidi % 12;

  // Find closest natural note
  let bestStep = 0;
  let bestAlter = 0;
  let bestDist = 99;
  for (let i = 0; i < SEMITONES.length; i++) {
    const dist = chromatic - SEMITONES[i];
    if (Math.abs(dist) < Math.abs(bestDist)) {
      bestStep = i;
      bestAlter = dist;
      bestDist = dist;
    }
  }

  stepEl.textContent = STEPS[bestStep];
  octaveEl.textContent = String(newOctave);
  if (bestAlter !== 0) {
    if (!alterEl) {
      const newAlter = doc.createElement("alter");
      newAlter.textContent = String(bestAlter);
      pitch.insertBefore(newAlter, octaveEl);
    } else {
      alterEl.textContent = String(bestAlter);
    }
  } else if (alterEl) {
    pitch.removeChild(alterEl);
  }

  return true;
}
```

**Step 4: Implement duration change and delete**

Similar pattern — modify the `<type>` element inside `<note>` for duration, or replace the note with a `<rest>` for delete.

**Step 5: Wire arrow keys and number keys to the editing functions**

In the `handleKeyDown` handler, add:

```typescript
if (selectedNoteIndexRef.current !== null) {
  if (e.key === "ArrowUp") {
    e.preventDefault();
    applyEdit((doc) => changePitch(doc, selectedNoteIndexRef.current!, 1));
  } else if (e.key === "ArrowDown") {
    e.preventDefault();
    applyEdit((doc) => changePitch(doc, selectedNoteIndexRef.current!, -1));
  } else if (e.key === "Delete" || e.key === "Backspace") {
    e.preventDefault();
    applyEdit((doc) => deleteNote(doc, selectedNoteIndexRef.current!));
  } else if (DURATION_MAP[e.key]) {
    e.preventDefault();
    applyEdit((doc) => changeDuration(doc, selectedNoteIndexRef.current!, DURATION_MAP[e.key].type));
  }
}
```

**Step 6: Commit**

```bash
git add client/src/components/NotationEditor.tsx client/src/index.css
git commit -m "feat: wire note selection, pitch/duration editing, and delete in NotationEditor"
```

---

## Task 10: Integrate NotationEditor into SheetDetail

**Files:**
- Modify: `client/src/pages/SheetDetail.tsx`

**Step 1: Add editor state and lazy import**

At the top of SheetDetail, add:

```typescript
import { lazy, Suspense } from "react";
const NotationEditor = lazy(() => import("@/components/NotationEditor"));
```

Add state:

```typescript
const [isEditing, setIsEditing] = useState(false);
const [musicxmlContent, setMusicxmlContent] = useState<string | null>(null);
```

**Step 2: Add "Review & Edit" button**

In the ready state UI (where the MIDI player is shown), add a button before or alongside existing controls:

```tsx
<Button
  variant="outline"
  onClick={async () => {
    // Fetch MusicXML content from storage
    if (!musicxmlContent && sheet.musicxmlKey) {
      const res = await fetch(`/files/${sheet.musicxmlKey}`);
      const xml = await res.text();
      setMusicxmlContent(xml);
    }
    setIsEditing(true);
  }}
>
  <Edit3 className="h-4 w-4 mr-2" />
  Review & Edit
</Button>
```

**Step 3: Add the `updateMusicXML` mutation**

```typescript
const updateMusicXMLMutation = trpc.sheetMusic.updateMusicXML.useMutation({
  onSuccess: () => {
    toast.success("Score updated — regenerating MIDI...");
    setIsEditing(false);
    setMusicxmlContent(null);
    utils.sheetMusic.get.invalidate({ id: sheetId });
  },
  onError: (err) => {
    toast.error(`Save failed: ${err.message}`);
  },
});
```

**Step 4: Render the editor when `isEditing`**

```tsx
{isEditing && musicxmlContent && (
  <Suspense fallback={<Loader2 className="h-8 w-8 animate-spin mx-auto" />}>
    <div className="fixed inset-0 z-50 bg-background">
      <div className="flex items-center justify-between p-2 border-b">
        <h3 className="font-semibold">Notation Editor — {sheet.title}</h3>
        <Button variant="ghost" onClick={() => setIsEditing(false)}>
          Close
        </Button>
      </div>
      <NotationEditor
        musicxml={musicxmlContent}
        pdfUrl={sheet.originalFileKey ? `/files/${sheet.originalFileKey}` : null}
        onSave={(xml) => updateMusicXMLMutation.mutate({ id: sheetId, musicxml: xml })}
        isSaving={updateMusicXMLMutation.isPending}
        className="h-[calc(100vh-49px)]"
      />
    </div>
  </Suspense>
)}
```

**Step 5: Add `Edit3` to the lucide-react import**

**Step 6: Commit**

```bash
git add client/src/pages/SheetDetail.tsx
git commit -m "feat: integrate NotationEditor into SheetDetail with Review & Edit button"
```

---

## Task 11: Install Audiveris on VPS and test end-to-end

**Files:** None (deployment task)

**Step 1: SSH into VPS and install Java + Audiveris**

```bash
ssh lex
sudo apt install -y openjdk-17-jre-headless
sudo mkdir -p /opt/audiveris
# Download the appropriate Audiveris release JAR
sudo curl -fsSL "https://github.com/Audiveris/audiveris/releases/download/5.4/Audiveris-5.4.jar" \
    -o /opt/audiveris/audiveris.jar
sudo bash -c 'cat > /usr/local/bin/audiveris << WRAPPER
#!/bin/bash
java -jar /opt/audiveris/audiveris.jar "\$@"
WRAPPER'
sudo chmod +x /usr/local/bin/audiveris

# Verify
audiveris -help
```

**Step 2: Deploy the new code**

```bash
cd /var/www/choir-voice-player
git pull
pnpm install
pnpm build
pm2 restart choir-satb choir-omr-service
```

**Step 3: Test the pipeline**

1. Upload a PDF through the web UI
2. Verify SSE shows "Running Audiveris OMR..."
3. Verify the sheet reaches "ready" status
4. Click "Review & Edit" and verify OSMD renders the score
5. Test pitch editing (arrow keys)
6. Save and verify MIDI regeneration

**Step 4: No commit needed (deployment only)**

---

## Task Summary

| # | Task | Type | Estimated Scope |
|---|------|------|----------------|
| 1 | Audiveris deployment scripts | Deploy | Small |
| 2 | Rewrite `process_pdf` for Audiveris | Backend | Medium |
| 3 | AI refinement step | Backend | Medium |
| 4 | Update process-pdf endpoint | Backend | Small |
| 5 | Update SSE events | Backend | Small |
| 6 | `updateMusicXML` tRPC procedure | Backend | Medium |
| 7 | Install OSMD + Vite chunk | Client | Small |
| 8 | NotationEditor component scaffold | Client | Large |
| 9 | Note selection & editing | Client | Large |
| 10 | Integrate editor into SheetDetail | Client | Medium |
| 11 | Deploy and test end-to-end | Deploy | Medium |

## Dependencies

```
Task 1 (deploy scripts) — independent
Tasks 2→3→4 (Python pipeline) — sequential
Task 5 (SSE) — after Task 4
Task 6 (updateMusicXML) — independent
Tasks 7→8→9 (OSMD editor) — sequential
Task 10 (integration) — after Tasks 6, 9
Task 11 (deploy) — after all
```

Parallelizable groups:
- **Group A:** Tasks 2, 3, 4, 5 (Python + server)
- **Group B:** Tasks 1, 6, 7, 8, 9 (deploy + client)
- **Final:** Task 10 (integration), then Task 11 (deploy)
