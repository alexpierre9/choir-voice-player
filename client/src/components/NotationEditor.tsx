import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { OpenSheetMusicDisplay as OSMD, unitInPixels } from "opensheetmusicdisplay";
import { usePlaybackSync } from "@/hooks/usePlaybackSync";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import {
  Undo2,
  Redo2,
  ChevronUp,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Trash2,
  Save,
  Loader2,
  Music,
  Flag,
  CheckCircle2,
} from "lucide-react";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface ConfidenceData {
  overall: number;
  per_measure: Array<{
    measure: number;
    confidence: number;
    corrections_applied: number;
  }>;
}

interface TooltipInfo {
  measure: number;
  confidence: number;
  corrections: number;
  clientX: number;
  clientY: number;
}

interface NotationEditorProps {
  musicxml: string;
  pdfUrl: string | null;
  onSave: (musicxml: string) => void;
  isSaving?: boolean;
  className?: string;
  /** "edit" = existing behavior (default). "review" = show confidence overlays + flag navigation. "follow" = score-following with blue measure highlight. */
  mode?: "edit" | "review" | "follow";
  /** Deep-correction confidence data from the Python service */
  confidence?: ConfidenceData | null;
  /** Called when the user approves the review. Receives the current XML. */
  onApprove?: (currentXml: string) => void;
}

// ── Pitch helpers ──────────────────────────────────────────────────────────────

const CHROMATIC_STEPS: { step: string; alter: number }[] = [
  { step: "C", alter: 0 },
  { step: "C", alter: 1 },
  { step: "D", alter: 0 },
  { step: "D", alter: 1 },
  { step: "E", alter: 0 },
  { step: "F", alter: 0 },
  { step: "F", alter: 1 },
  { step: "G", alter: 0 },
  { step: "G", alter: 1 },
  { step: "A", alter: 0 },
  { step: "A", alter: 1 },
  { step: "B", alter: 0 },
];

function pitchToMidi(step: string, octave: number, alter: number): number {
  const stepIndex: Record<string, number> = {
    C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11,
  };
  return (octave + 1) * 12 + (stepIndex[step] ?? 0) + alter;
}

function midiToPitch(midi: number): { step: string; octave: number; alter: number } {
  const octave = Math.floor(midi / 12) - 1;
  const semitone = ((midi % 12) + 12) % 12;
  const entry = CHROMATIC_STEPS[semitone];
  return { step: entry.step, octave, alter: entry.alter };
}

const DURATION_MAP: Record<string, string> = {
  "1": "whole",
  "2": "half",
  "4": "quarter",
  "8": "eighth",
};

const DURATION_LABELS: Record<string, string> = {
  "1": "Whole",
  "2": "Half",
  "4": "Quarter",
  "8": "Eighth",
};

// ── Measure timing helpers ────────────────────────────────────────────────────

/**
 * Parse MusicXML to produce an array of measure start times (seconds, 0-indexed).
 * Uses the first <part> element; handles multi-voice via backup/forward tracking.
 */
function buildMeasureTimings(xml: string): number[] {
  try {
    const doc = new DOMParser().parseFromString(xml, "text/xml");
    const firstPart = doc.querySelector("part");
    if (!firstPart) return [];

    const measures = Array.from(firstPart.querySelectorAll("measure"));
    let divisions = 1;
    let tempo = 120; // default BPM
    let currentTime = 0;
    const timings: number[] = [];

    for (const measure of measures) {
      timings.push(currentTime);

      // Update divisions if the measure changes them
      const divisionsEl = measure.querySelector("attributes > divisions");
      if (divisionsEl?.textContent) {
        const parsed = parseInt(divisionsEl.textContent, 10);
        if (parsed > 0) divisions = parsed;
      }

      // Update tempo if a <sound tempo="..."/> directive is present
      const soundEl = measure.querySelector("sound[tempo]");
      if (soundEl) {
        const parsed = parseFloat(soundEl.getAttribute("tempo") ?? "120");
        if (parsed > 0) tempo = parsed;
      }

      // Compute duration by tracking the furthest timeline position reached.
      // backup elements move the cursor backward (multi-voice); forward moves it forward.
      let position = 0;
      let maxPosition = 0;

      for (const child of Array.from(measure.children)) {
        switch (child.tagName) {
          case "note": {
            // Chord notes share the previous note's time slot — don't advance
            if (child.querySelector("chord")) break;
            const durEl = child.querySelector("duration");
            if (durEl?.textContent) {
              position += parseInt(durEl.textContent, 10) || 0;
              if (position > maxPosition) maxPosition = position;
            }
            break;
          }
          case "backup": {
            const durEl = child.querySelector("duration");
            if (durEl?.textContent) {
              position -= parseInt(durEl.textContent, 10) || 0;
              if (position < 0) position = 0;
            }
            break;
          }
          case "forward": {
            const durEl = child.querySelector("duration");
            if (durEl?.textContent) {
              position += parseInt(durEl.textContent, 10) || 0;
              if (position > maxPosition) maxPosition = position;
            }
            break;
          }
        }
      }

      if (maxPosition > 0) {
        currentTime += (maxPosition / divisions) * (60 / tempo);
      }
    }

    return timings;
  } catch {
    return [];
  }
}

/**
 * Given a current playback time and an array of measure start times,
 * returns the 0-based index of the measure currently playing (-1 if before start).
 */
function findMeasureAtTime(timeSec: number, timings: number[]): number {
  if (!timings.length || timeSec < 0) return -1;
  let idx = 0;
  for (let i = 0; i < timings.length; i++) {
    if (timings[i] <= timeSec) idx = i;
    else break;
  }
  return idx;
}

// ── Component ──────────────────────────────────────────────────────────────────

export default function NotationEditor({
  musicxml,
  pdfUrl,
  onSave,
  isSaving = false,
  className,
  mode = "edit",
  confidence,
  onApprove,
}: NotationEditorProps) {
  // State
  const [currentXml, setCurrentXml] = useState(musicxml);
  const [undoStack, setUndoStack] = useState<string[]>([]);
  const [redoStack, setRedoStack] = useState<string[]>([]);
  const [hasChanges, setHasChanges] = useState(false);
  const [isRendering, setIsRendering] = useState(true);
  const [selectedNoteInfo, setSelectedNoteInfo] = useState<string | null>(null);
  const [tooltipInfo, setTooltipInfo] = useState<TooltipInfo | null>(null);
  const [currentFlagIndex, setCurrentFlagIndex] = useState(0);
  const [isApproved, setIsApproved] = useState(false);

  // Refs
  const containerRef = useRef<HTMLDivElement>(null);
  const scoreWrapperRef = useRef<HTMLDivElement>(null);
  const osmdRef = useRef<OSMD | null>(null);
  const selectedNoteIndexRef = useRef<number | null>(null);
  const currentXmlRef = useRef(currentXml);
  const undoStackRef = useRef(undoStack);
  const redoStackRef = useRef(redoStack);

  // Keep refs in sync
  useEffect(() => { currentXmlRef.current = currentXml; }, [currentXml]);
  useEffect(() => { undoStackRef.current = undoStack; }, [undoStack]);
  useEffect(() => { redoStackRef.current = redoStack; }, [redoStack]);

  // ── Score-following state ─────────────────────────────────────────────────

  const playbackSync = usePlaybackSync();
  const currentTimeSec = playbackSync?.currentTimeSec ?? 0;

  /** Pre-computed array of measure start times (seconds). Only built in follow mode. */
  const measureTimings = useMemo(() => {
    if (mode !== "follow") return [] as number[];
    return buildMeasureTimings(currentXml);
  }, [mode, currentXml]);

  /** Tracks the last measure index we highlighted so we only update DOM on change. */
  const lastHighlightedMeasureRef = useRef<number>(-1);

  /** Draw (or move) a blue follow overlay onto the current measure. */
  const drawFollowOverlay = useCallback((measureIndex: number) => {
    const wrapper = scoreWrapperRef.current;
    const container = containerRef.current;
    if (!wrapper || !container || !osmdRef.current) return;

    // Remove stale follow overlay
    wrapper.querySelectorAll(".follow-overlay").forEach((el) => el.remove());

    if (measureIndex < 0) return;

    const osmd = osmdRef.current as any;
    const measureList: Array<Array<any>> | undefined = osmd.graphic?.MeasureList;
    if (!measureList?.length || measureIndex >= measureList.length) return;

    const staveMeasures = measureList[measureIndex];
    if (!staveMeasures?.length) return;

    const scale = unitInPixels * (osmd.zoom ?? 1);
    const svgEl = container.querySelector("svg");
    if (!svgEl) return;
    const wrapperRect = wrapper.getBoundingClientRect();
    const svgRect = svgEl.getBoundingClientRect();
    const svgLeft = svgRect.left - wrapperRect.left + wrapper.scrollLeft;
    const svgTop = svgRect.top - wrapperRect.top + wrapper.scrollTop;

    // Bounding box spanning all staves for this measure column
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    staveMeasures.forEach((gm: any) => {
      const bb = gm?.PositionAndShape;
      if (!bb) return;
      const pos = bb.AbsolutePosition;
      const sz = bb.Size;
      if (!pos || !sz) return;
      minX = Math.min(minX, pos.x);
      minY = Math.min(minY, pos.y);
      maxX = Math.max(maxX, pos.x + sz.width);
      maxY = Math.max(maxY, pos.y + sz.height);
    });
    if (!isFinite(minX)) return;

    const left = svgLeft + minX * scale;
    const top = svgTop + minY * scale;
    const width = (maxX - minX) * scale;
    const height = (maxY - minY) * scale;

    const overlay = document.createElement("div");
    overlay.className = "follow-overlay";
    overlay.style.cssText = [
      "position:absolute",
      `left:${left}px`,
      `top:${top}px`,
      `width:${width}px`,
      `height:${height}px`,
      "background-color:rgba(59,130,246,0.2)",
      "border:2px solid rgba(59,130,246,0.5)",
      "border-radius:2px",
      "pointer-events:none",
      "z-index:6",
      "transition:left 0.1s ease,top 0.1s ease",
    ].join(";");

    wrapper.appendChild(overlay);

    // Auto-scroll to keep highlighted measure visible (only when measure changes)
    overlay.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, []);

  // Update follow overlay whenever currentTimeSec changes (in follow mode only)
  useEffect(() => {
    if (mode !== "follow" || isRendering) return;

    const measureIndex = findMeasureAtTime(currentTimeSec, measureTimings);
    if (measureIndex === lastHighlightedMeasureRef.current) return;

    lastHighlightedMeasureRef.current = measureIndex;
    drawFollowOverlay(measureIndex);
  }, [currentTimeSec, mode, isRendering, measureTimings, drawFollowOverlay]);

  // Clean up follow overlays when leaving follow mode or on unmount
  useEffect(() => {
    if (mode !== "follow") {
      scoreWrapperRef.current?.querySelectorAll(".follow-overlay").forEach((el) => el.remove());
      lastHighlightedMeasureRef.current = -1;
    }
  }, [mode]);

  // ── Confidence helpers ────────────────────────────────────────────────────

  /** Measures with confidence < 0.9 in ascending order */
  const flaggedMeasures = useMemo(() => {
    if (!confidence) return [];
    return confidence.per_measure
      .filter(m => m.confidence < 0.9)
      .map(m => m.measure)
      .sort((a, b) => a - b);
  }, [confidence]);

  // ── Measure confidence overlays ───────────────────────────────────────────

  const drawConfidenceOverlays = useCallback(() => {
    const wrapper = scoreWrapperRef.current;
    const container = containerRef.current;
    if (!wrapper || !container || !osmdRef.current || !confidence) return;

    // Remove stale overlays
    wrapper.querySelectorAll(".measure-overlay").forEach(el => el.remove());

    const osmd = osmdRef.current as any;
    // MeasureList is a getter (capital M) on GraphicalMusicSheet
    const measureList: Array<Array<any>> | undefined = osmd.graphic?.MeasureList;
    if (!measureList?.length) return;

    // unitInPixels constant (10) × zoom = screen pixels per OSMD unit
    const scale = unitInPixels * (osmd.zoom ?? 1);

    // SVG element position relative to wrapper (accounting for current scroll)
    const svgEl = container.querySelector("svg");
    if (!svgEl) return;
    const wrapperRect = wrapper.getBoundingClientRect();
    const svgRect = svgEl.getBoundingClientRect();
    const svgLeft = svgRect.left - wrapperRect.left + wrapper.scrollLeft;
    const svgTop = svgRect.top - wrapperRect.top + wrapper.scrollTop;

    // Build O(1) lookup: measure number → confidence data
    const confidenceMap = new Map<
      number,
      { confidence: number; corrections_applied: number }
    >();
    confidence.per_measure.forEach(m => {
      confidenceMap.set(m.measure, {
        confidence: m.confidence,
        corrections_applied: m.corrections_applied,
      });
    });

    measureList.forEach((staveMeasures, measureIndex) => {
      if (!staveMeasures?.length) return;

      const measureNum = measureIndex + 1; // 1-based
      const data = confidenceMap.get(measureNum);
      if (!data) return;

      // Compute bounding box spanning all staves for this measure column
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      staveMeasures.forEach((gm: any) => {
        const bb = gm?.PositionAndShape;
        if (!bb) return;
        const pos = bb.AbsolutePosition;
        const sz = bb.Size;
        if (!pos || !sz) return;
        minX = Math.min(minX, pos.x);
        minY = Math.min(minY, pos.y);
        maxX = Math.max(maxX, pos.x + sz.width);
        maxY = Math.max(maxY, pos.y + sz.height);
      });
      if (!isFinite(minX)) return;

      const left = svgLeft + minX * scale;
      const top = svgTop + minY * scale;
      const width = (maxX - minX) * scale;
      const height = (maxY - minY) * scale;

      // Colour by confidence tier
      let bgColor: string;
      if (data.confidence >= 0.9) bgColor = "rgba(34, 197, 94, 0.1)";
      else if (data.confidence >= 0.7) bgColor = "rgba(234, 179, 8, 0.15)";
      else bgColor = "rgba(239, 68, 68, 0.2)";

      const overlay = document.createElement("div");
      overlay.className = "measure-overlay";
      overlay.dataset.measure = String(measureNum);
      overlay.style.cssText = [
        "position:absolute",
        `left:${left}px`,
        `top:${top}px`,
        `width:${width}px`,
        `height:${height}px`,
        `background-color:${bgColor}`,
        "cursor:pointer",
        "z-index:5",
        "pointer-events:auto",
      ].join(";");

      overlay.addEventListener("click", (e) => {
        e.stopPropagation();
        setTooltipInfo({
          measure: measureNum,
          confidence: data.confidence,
          corrections: data.corrections_applied,
          clientX: (e as MouseEvent).clientX,
          clientY: (e as MouseEvent).clientY,
        });
      });

      wrapper.appendChild(overlay);
    });
  }, [confidence]);

  // Draw (or redraw) overlays whenever rendering finishes
  useEffect(() => {
    if (!isRendering && confidence && mode === "review") {
      // Small delay to ensure SVG is fully painted in the DOM
      const id = setTimeout(() => drawConfidenceOverlays(), 50);
      return () => clearTimeout(id);
    }
    // If not in review mode or no confidence, clean up any stale overlays
    if (!isRendering && (!confidence || mode !== "review")) {
      scoreWrapperRef.current?.querySelectorAll(".measure-overlay").forEach(el => el.remove());
    }
  }, [isRendering, confidence, mode, drawConfidenceOverlays]);

  // Redraw overlays on container resize (e.g., window resize or panel resize)
  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver(() => {
      if (!isRendering && confidence && mode === "review") {
        drawConfidenceOverlays();
      }
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [isRendering, confidence, mode, drawConfidenceOverlays]);

  // Dismiss tooltip on outside click
  useEffect(() => {
    if (!tooltipInfo) return;
    const dismiss = () => setTooltipInfo(null);
    window.addEventListener("click", dismiss, { capture: true, once: true });
    return () => window.removeEventListener("click", dismiss, { capture: true });
  }, [tooltipInfo]);

  // ── Flagged measure navigation ────────────────────────────────────────────

  const goToFlag = useCallback((index: number) => {
    if (!flaggedMeasures.length) return;
    const clamped = ((index % flaggedMeasures.length) + flaggedMeasures.length) % flaggedMeasures.length;
    setCurrentFlagIndex(clamped);
    const measureNum = flaggedMeasures[clamped];
    const overlay = scoreWrapperRef.current?.querySelector(`[data-measure="${measureNum}"]`);
    overlay?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [flaggedMeasures]);

  // ── OSMD rendering ────────────────────────────────────────────────────────

  const renderOsmd = useCallback(async (xml: string) => {
    if (!containerRef.current) return;
    setIsRendering(true);

    try {
      if (!osmdRef.current) {
        osmdRef.current = new OSMD(containerRef.current, {
          autoResize: true,
          drawTitle: true,
          drawComposer: true,
        });
      }
      await osmdRef.current.load(xml);
      osmdRef.current.render();
      attachNoteClickHandlers();
    } catch (err) {
      console.error("OSMD render error:", err);
    } finally {
      setIsRendering(false);
    }
  }, []);

  // Initial render
  useEffect(() => {
    renderOsmd(currentXml);
    return () => {
      if (osmdRef.current) {
        osmdRef.current.clear();
        osmdRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Note selection via SVG click ──────────────────────────────────────────

  const clearSelection = useCallback(() => {
    if (!containerRef.current) return;
    containerRef.current
      .querySelectorAll(".note-selected")
      .forEach((el) => el.classList.remove("note-selected"));
    selectedNoteIndexRef.current = null;
    setSelectedNoteInfo(null);
  }, []);

  const attachNoteClickHandlers = useCallback(() => {
    if (!containerRef.current) return;

    const noteElements = containerRef.current.querySelectorAll(".vf-stavenote");
    noteElements.forEach((el, index) => {
      (el as HTMLElement).style.cursor = "pointer";
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        containerRef.current
          ?.querySelectorAll(".note-selected")
          .forEach((prev) => prev.classList.remove("note-selected"));
        el.classList.add("note-selected");
        selectedNoteIndexRef.current = index;
        const info = getNoteInfoAtIndex(currentXmlRef.current, index);
        setSelectedNoteInfo(info);
      });
    });

    containerRef.current.addEventListener("click", (e) => {
      if (!(e.target as Element).closest(".vf-stavenote")) {
        clearSelection();
      }
    });
  }, [clearSelection]);

  // ── XML helpers ───────────────────────────────────────────────────────────

  function parseXml(xml: string): Document {
    return new DOMParser().parseFromString(xml, "text/xml");
  }

  function serializeXml(doc: Document): string {
    return new XMLSerializer().serializeToString(doc);
  }

  function getSoundingNotes(doc: Document): Element[] {
    return Array.from(doc.querySelectorAll("note")).filter(
      (n) => !n.querySelector("rest"),
    );
  }

  function getNoteInfoAtIndex(xml: string, index: number): string | null {
    const doc = parseXml(xml);
    const notes = getSoundingNotes(doc);
    if (index < 0 || index >= notes.length) return null;
    const note = notes[index];
    const step = note.querySelector("pitch > step")?.textContent ?? "?";
    const octave = note.querySelector("pitch > octave")?.textContent ?? "?";
    const alter = note.querySelector("pitch > alter")?.textContent;
    const type = note.querySelector("type")?.textContent ?? "?";
    const accidental = alter ? (Number(alter) > 0 ? "#" : "b") : "";
    return `${step}${accidental}${octave} (${type})`;
  }

  // ── Edit engine ───────────────────────────────────────────────────────────

  const applyEdit = useCallback(
    (editFn: (doc: Document, noteIndex: number) => boolean) => {
      const noteIndex = selectedNoteIndexRef.current;
      if (noteIndex === null) return;

      const doc = parseXml(currentXmlRef.current);
      const success = editFn(doc, noteIndex);
      if (!success) return;

      const newXml = serializeXml(doc);
      setUndoStack((prev) => [...prev, currentXmlRef.current]);
      setRedoStack([]);
      setCurrentXml(newXml);
      setHasChanges(true);

      renderOsmd(newXml).then(() => {
        const noteEls = containerRef.current?.querySelectorAll(".vf-stavenote");
        if (noteEls && noteIndex < noteEls.length) {
          noteEls[noteIndex].classList.add("note-selected");
          selectedNoteIndexRef.current = noteIndex;
          const info = getNoteInfoAtIndex(newXml, noteIndex);
          setSelectedNoteInfo(info);
        }
      });
    },
    [renderOsmd],
  );

  // ── Edit operations ───────────────────────────────────────────────────────

  const changePitch = useCallback(
    (semitones: number) => {
      applyEdit((doc, noteIndex) => {
        const notes = getSoundingNotes(doc);
        if (noteIndex >= notes.length) return false;
        const note = notes[noteIndex];
        const stepEl = note.querySelector("pitch > step");
        const octaveEl = note.querySelector("pitch > octave");
        const alterEl = note.querySelector("pitch > alter");
        if (!stepEl || !octaveEl) return false;
        const midi =
          pitchToMidi(
            stepEl.textContent ?? "C",
            parseInt(octaveEl.textContent ?? "4", 10),
            alterEl ? parseInt(alterEl.textContent ?? "0", 10) : 0,
          ) + semitones;
        if (midi < 0 || midi > 127) return false;
        const newPitch = midiToPitch(midi);
        stepEl.textContent = newPitch.step;
        octaveEl.textContent = String(newPitch.octave);
        if (newPitch.alter !== 0) {
          if (alterEl) {
            alterEl.textContent = String(newPitch.alter);
          } else {
            const newAlter = doc.createElement("alter");
            newAlter.textContent = String(newPitch.alter);
            const pitchEl = note.querySelector("pitch");
            if (pitchEl && stepEl.nextSibling) {
              pitchEl.insertBefore(newAlter, stepEl.nextSibling);
            } else {
              pitchEl?.appendChild(newAlter);
            }
          }
        } else if (alterEl) {
          alterEl.parentNode?.removeChild(alterEl);
        }
        return true;
      });
    },
    [applyEdit],
  );

  const changeDuration = useCallback(
    (durationKey: string) => {
      const newType = DURATION_MAP[durationKey];
      if (!newType) return;
      applyEdit((doc, noteIndex) => {
        const notes = getSoundingNotes(doc);
        if (noteIndex >= notes.length) return false;
        const typeEl = notes[noteIndex].querySelector("type");
        if (!typeEl) return false;
        typeEl.textContent = newType;
        return true;
      });
    },
    [applyEdit],
  );

  const deleteNote = useCallback(() => {
    applyEdit((doc, noteIndex) => {
      const notes = getSoundingNotes(doc);
      if (noteIndex >= notes.length) return false;
      const note = notes[noteIndex];
      const pitchEl = note.querySelector("pitch");
      if (pitchEl) pitchEl.parentNode?.removeChild(pitchEl);
      if (!note.querySelector("rest")) {
        note.insertBefore(doc.createElement("rest"), note.firstChild);
      }
      let typeEl = note.querySelector("type");
      if (!typeEl) {
        typeEl = doc.createElement("type");
        note.appendChild(typeEl);
      }
      typeEl.textContent = "quarter";
      return true;
    });
  }, [applyEdit]);

  // ── Undo / Redo ───────────────────────────────────────────────────────────

  const undo = useCallback(() => {
    const stack = undoStackRef.current;
    if (stack.length === 0) return;
    const previous = stack[stack.length - 1];
    setUndoStack((prev) => prev.slice(0, -1));
    setRedoStack((prev) => [...prev, currentXmlRef.current]);
    setCurrentXml(previous);
    setHasChanges(stack.length > 1);
    clearSelection();
    renderOsmd(previous);
  }, [clearSelection, renderOsmd]);

  const redo = useCallback(() => {
    const stack = redoStackRef.current;
    if (stack.length === 0) return;
    const next = stack[stack.length - 1];
    setRedoStack((prev) => prev.slice(0, -1));
    setUndoStack((prev) => [...prev, currentXmlRef.current]);
    setCurrentXml(next);
    setHasChanges(true);
    clearSelection();
    renderOsmd(next);
  }, [clearSelection, renderOsmd]);

  // ── Save / Approve ────────────────────────────────────────────────────────

  const handleSave = useCallback(() => {
    onSave(currentXmlRef.current);
  }, [onSave]);

  const handleApprove = useCallback(() => {
    setIsApproved(true);
    onApprove?.(currentXmlRef.current);
  }, [onApprove]);

  // ── Keyboard shortcuts ────────────────────────────────────────────────────

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.key === "z") { e.preventDefault(); undo(); return; }
      if (ctrl && e.key === "y") { e.preventDefault(); redo(); return; }
      if (ctrl && e.key === "s") { e.preventDefault(); handleSave(); return; }
      if (selectedNoteIndexRef.current === null) return;
      if (e.key === "ArrowUp") { e.preventDefault(); changePitch(1); }
      else if (e.key === "ArrowDown") { e.preventDefault(); changePitch(-1); }
      else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); deleteNote(); }
      else if (e.key in DURATION_MAP) { e.preventDefault(); changeDuration(e.key); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [undo, redo, handleSave, changePitch, changeDuration, deleteNote]);

  // ── Toolbar button helper ─────────────────────────────────────────────────

  function ToolbarButton({
    icon: Icon,
    label,
    shortcut,
    onClick,
    disabled = false,
    active = false,
  }: {
    icon: React.ComponentType<{ className?: string }>;
    label: string;
    shortcut?: string;
    onClick: () => void;
    disabled?: boolean;
    active?: boolean;
  }) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant={active ? "default" : "ghost"}
            size="icon-sm"
            onClick={onClick}
            disabled={disabled}
            aria-label={label}
          >
            <Icon className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {label}
          {shortcut && (
            <kbd className="ml-1.5 text-[10px] font-mono opacity-60">
              {shortcut}
            </kbd>
          )}
        </TooltipContent>
      </Tooltip>
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const noteSelected = selectedNoteIndexRef.current !== null;
  const isReviewMode = mode === "review";
  const isFollowMode = mode === "follow";
  const overallPct = confidence ? Math.round(confidence.overall * 100) : null;

  // ── Derive current measure label for follow mode ──────────────────────────
  const followMeasureLabel = isFollowMode && measureTimings.length > 0
    ? `Measure ${lastHighlightedMeasureRef.current >= 0 ? lastHighlightedMeasureRef.current + 1 : "—"} / ${measureTimings.length}`
    : null;

  return (
    <div className={cn("flex flex-col h-full", className)}>
      {/* Toolbar — hidden in follow mode; replaced by a slim "Following" bar */}
      {isFollowMode ? (
        <div className="flex items-center gap-2 px-3 py-1.5 border-b bg-blue-50 dark:bg-blue-950/30 text-sm text-blue-700 dark:text-blue-300">
          <span className="inline-block w-2.5 h-2.5 rounded-full bg-blue-500 animate-pulse" />
          <span className="font-medium">Score Following</span>
          {followMeasureLabel && (
            <span className="ml-auto font-mono text-xs opacity-70">{followMeasureLabel}</span>
          )}
        </div>
      ) : (
      <div className="flex items-center gap-1 p-2 border-b bg-muted/30 flex-wrap">
        {/* Undo / Redo */}
        <ToolbarButton icon={Undo2} label="Undo" shortcut="Ctrl+Z" onClick={undo} disabled={undoStack.length === 0} />
        <ToolbarButton icon={Redo2} label="Redo" shortcut="Ctrl+Y" onClick={redo} disabled={redoStack.length === 0} />

        <Separator orientation="vertical" className="mx-1 h-6" />

        {/* Pitch */}
        <ToolbarButton icon={ChevronUp} label="Pitch Up" shortcut="Arrow Up" onClick={() => changePitch(1)} disabled={!noteSelected} />
        <ToolbarButton icon={ChevronDown} label="Pitch Down" shortcut="Arrow Down" onClick={() => changePitch(-1)} disabled={!noteSelected} />

        <Separator orientation="vertical" className="mx-1 h-6" />

        {/* Delete */}
        <ToolbarButton icon={Trash2} label="Delete Note" shortcut="Del" onClick={deleteNote} disabled={!noteSelected} />

        <Separator orientation="vertical" className="mx-1 h-6" />

        {/* Durations */}
        {Object.entries(DURATION_LABELS).map(([key, label]) => (
          <Tooltip key={key}>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => changeDuration(key)}
                disabled={!noteSelected}
                aria-label={`${label} note`}
              >
                <span className="text-xs font-mono font-bold">{"1/" + key}</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {label} note
              <kbd className="ml-1.5 text-[10px] font-mono opacity-60">{key}</kbd>
            </TooltipContent>
          </Tooltip>
        ))}

        {/* Review mode: flag navigation + confidence legend */}
        {isReviewMode && confidence && (
          <>
            <Separator orientation="vertical" className="mx-1 h-6" />

            {/* Flag navigation */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => goToFlag(currentFlagIndex - 1)}
                  disabled={flaggedMeasures.length === 0}
                  aria-label="Previous flagged measure"
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Previous Flag</TooltipContent>
            </Tooltip>

            <div className="flex items-center gap-1 px-1.5 text-xs text-amber-600 font-medium">
              <Flag className="h-3.5 w-3.5" />
              <span>
                {flaggedMeasures.length > 0
                  ? `${flaggedMeasures.length} flagged`
                  : "No flags"}
              </span>
            </div>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => goToFlag(currentFlagIndex + 1)}
                  disabled={flaggedMeasures.length === 0}
                  aria-label="Next flagged measure"
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Next Flag</TooltipContent>
            </Tooltip>

            <Separator orientation="vertical" className="mx-1 h-6" />

            {/* Confidence legend */}
            <div className="flex items-center gap-2 px-1 text-[11px] text-muted-foreground">
              <span className="flex items-center gap-0.5">
                <span className="inline-block w-2 h-2 rounded-full bg-green-500 opacity-70" />
                High
              </span>
              <span className="flex items-center gap-0.5">
                <span className="inline-block w-2 h-2 rounded-full bg-yellow-500 opacity-70" />
                Medium
              </span>
              <span className="flex items-center gap-0.5">
                <span className="inline-block w-2 h-2 rounded-full bg-red-500 opacity-70" />
                Low
              </span>
              {overallPct !== null && (
                <span className="ml-1 font-medium text-foreground">
                  Overall: {overallPct}%
                </span>
              )}
            </div>

            <Separator orientation="vertical" className="mx-1 h-6" />
          </>
        )}

        {/* Note info */}
        {selectedNoteInfo && (
          <div className="flex items-center gap-1.5 px-2 text-xs text-muted-foreground">
            <Music className="h-3.5 w-3.5" />
            <span className="font-mono">{selectedNoteInfo}</span>
          </div>
        )}

        {/* Spacer */}
        <div className="flex-1" />

        {/* Review mode: Approve button */}
        {isReviewMode && (
          <Button
            variant={isApproved ? "secondary" : "default"}
            size="sm"
            onClick={handleApprove}
            disabled={isApproved || isSaving}
            className={isApproved ? "text-green-600" : "bg-green-600 hover:bg-green-700 text-white"}
          >
            {isSaving ? (
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
            ) : (
              <CheckCircle2 className="mr-1.5 h-4 w-4" />
            )}
            {isApproved ? "Approved" : "Approve"}
          </Button>
        )}

        {/* Save */}
        <Button
          variant={isReviewMode ? "outline" : "default"}
          size="sm"
          onClick={handleSave}
          disabled={!hasChanges || isSaving}
        >
          {isSaving ? (
            <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
          ) : (
            <Save className="mr-1.5 h-4 w-4" />
          )}
          Save
        </Button>
      </div>
      )}

      {/* Split view: PDF + OSMD */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* PDF viewer */}
        {pdfUrl && (
          <div className="w-1/2 border-r">
            <iframe src={pdfUrl} title="Original PDF" className="w-full h-full border-0" />
          </div>
        )}

        {/* OSMD score wrapper — position:relative so overlays are children */}
        <div
          ref={scoreWrapperRef}
          className={cn("relative overflow-auto", pdfUrl ? "w-1/2" : "w-full")}
          onClick={() => setTooltipInfo(null)}
        >
          {isRendering && (
            <div className="absolute inset-0 flex items-center justify-center bg-background/80 z-10">
              <div className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin" />
                <span className="text-sm">Rendering score...</span>
              </div>
            </div>
          )}
          <div ref={containerRef} className="p-4" />

          {/* Measure confidence tooltip (fixed so it doesn't scroll) */}
          {tooltipInfo && (
            <div
              className="fixed z-50 pointer-events-none bg-popover text-popover-foreground text-xs px-3 py-1.5 rounded-md shadow-md border"
              style={{
                left: tooltipInfo.clientX,
                top: tooltipInfo.clientY - 8,
                transform: "translate(-50%, -100%)",
              }}
            >
              <span className="font-semibold">Measure {tooltipInfo.measure}</span>
              {" — "}
              Confidence: {Math.round(tooltipInfo.confidence * 100)}%
              {" — "}
              {tooltipInfo.corrections} correction{tooltipInfo.corrections !== 1 ? "s" : ""} applied
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
