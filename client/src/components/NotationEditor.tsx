import { useCallback, useEffect, useRef, useState } from "react";
import { OpenSheetMusicDisplay as OSMD } from "opensheetmusicdisplay";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import {
  Undo2,
  Redo2,
  ChevronUp,
  ChevronDown,
  Trash2,
  Save,
  Loader2,
  Music,
} from "lucide-react";

// ── Types ──────────────────────────────────────────────────────────────────────

interface NotationEditorProps {
  musicxml: string;
  pdfUrl: string | null;
  onSave: (musicxml: string) => void;
  isSaving?: boolean;
  className?: string;
}

// ── Pitch helpers ──────────────────────────────────────────────────────────────

// MusicXML step names in chromatic order (with sharp preference for accidentals)
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

// MusicXML <type> values mapped to toolbar keys
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

// ── Component ──────────────────────────────────────────────────────────────────

export default function NotationEditor({
  musicxml,
  pdfUrl,
  onSave,
  isSaving = false,
  className,
}: NotationEditorProps) {
  // State
  const [currentXml, setCurrentXml] = useState(musicxml);
  const [undoStack, setUndoStack] = useState<string[]>([]);
  const [redoStack, setRedoStack] = useState<string[]>([]);
  const [hasChanges, setHasChanges] = useState(false);
  const [isRendering, setIsRendering] = useState(true);
  const [selectedNoteInfo, setSelectedNoteInfo] = useState<string | null>(null);

  // Refs
  const containerRef = useRef<HTMLDivElement>(null);
  const osmdRef = useRef<OSMD | null>(null);
  const selectedNoteIndexRef = useRef<number | null>(null);
  const currentXmlRef = useRef(currentXml);
  const undoStackRef = useRef(undoStack);
  const redoStackRef = useRef(redoStack);

  // Keep refs in sync
  useEffect(() => { currentXmlRef.current = currentXml; }, [currentXml]);
  useEffect(() => { undoStackRef.current = undoStack; }, [undoStack]);
  useEffect(() => { redoStackRef.current = redoStack; }, [redoStack]);

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

    // OSMD renders notes as SVG <g> elements with class "vf-stavenote"
    const noteElements = containerRef.current.querySelectorAll(
      ".vf-stavenote"
    );

    noteElements.forEach((el, index) => {
      (el as HTMLElement).style.cursor = "pointer";
      el.addEventListener("click", (e) => {
        e.stopPropagation();

        // Clear previous selection
        containerRef.current
          ?.querySelectorAll(".note-selected")
          .forEach((prev) => prev.classList.remove("note-selected"));

        // Highlight this note
        el.classList.add("note-selected");
        selectedNoteIndexRef.current = index;

        // Read note info from MusicXML
        const info = getNoteInfoAtIndex(currentXmlRef.current, index);
        setSelectedNoteInfo(info);
      });
    });

    // Click on background clears selection
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

  /** Get all <note> elements that are NOT rests. */
  function getSoundingNotes(doc: Document): Element[] {
    const allNotes = Array.from(doc.querySelectorAll("note"));
    return allNotes.filter((n) => !n.querySelector("rest"));
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

      // Push current state to undo
      setUndoStack((prev) => [...prev, currentXmlRef.current]);
      setRedoStack([]);
      setCurrentXml(newXml);
      setHasChanges(true);

      // Re-render
      renderOsmd(newXml).then(() => {
        // Reselect the same note index after re-render
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

        const currentStep = stepEl.textContent ?? "C";
        const currentOctave = parseInt(octaveEl.textContent ?? "4", 10);
        const currentAlter = alterEl ? parseInt(alterEl.textContent ?? "0", 10) : 0;

        const midi = pitchToMidi(currentStep, currentOctave, currentAlter) + semitones;
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
            // Insert after <step>
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

        const note = notes[noteIndex];
        const typeEl = note.querySelector("type");
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
      // Replace with a rest: remove pitch, add rest element
      const pitchEl = note.querySelector("pitch");
      if (pitchEl) pitchEl.parentNode?.removeChild(pitchEl);

      // Remove existing rest if any (shouldn't exist for sounding notes, but be safe)
      const existingRest = note.querySelector("rest");
      if (!existingRest) {
        const restEl = doc.createElement("rest");
        // Insert rest as first child
        note.insertBefore(restEl, note.firstChild);
      }

      // Set type to quarter if not already set
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

  // ── Save ──────────────────────────────────────────────────────────────────

  const handleSave = useCallback(() => {
    onSave(currentXmlRef.current);
  }, [onSave]);

  // ── Keyboard shortcuts ────────────────────────────────────────────────────

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      const ctrl = e.ctrlKey || e.metaKey;

      if (ctrl && e.key === "z") {
        e.preventDefault();
        undo();
        return;
      }
      if (ctrl && e.key === "y") {
        e.preventDefault();
        redo();
        return;
      }
      if (ctrl && e.key === "s") {
        e.preventDefault();
        handleSave();
        return;
      }

      // Note-specific shortcuts (only when a note is selected)
      if (selectedNoteIndexRef.current === null) return;

      if (e.key === "ArrowUp") {
        e.preventDefault();
        changePitch(1);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        changePitch(-1);
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        deleteNote();
      } else if (e.key in DURATION_MAP) {
        e.preventDefault();
        changeDuration(e.key);
      }
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

  return (
    <div className={cn("flex flex-col h-full", className)}>
      {/* Toolbar */}
      <div className="flex items-center gap-1 p-2 border-b bg-muted/30 flex-wrap">
        {/* Undo / Redo */}
        <ToolbarButton
          icon={Undo2}
          label="Undo"
          shortcut="Ctrl+Z"
          onClick={undo}
          disabled={undoStack.length === 0}
        />
        <ToolbarButton
          icon={Redo2}
          label="Redo"
          shortcut="Ctrl+Y"
          onClick={redo}
          disabled={redoStack.length === 0}
        />

        <Separator orientation="vertical" className="mx-1 h-6" />

        {/* Pitch */}
        <ToolbarButton
          icon={ChevronUp}
          label="Pitch Up"
          shortcut="Arrow Up"
          onClick={() => changePitch(1)}
          disabled={!noteSelected}
        />
        <ToolbarButton
          icon={ChevronDown}
          label="Pitch Down"
          shortcut="Arrow Down"
          onClick={() => changePitch(-1)}
          disabled={!noteSelected}
        />

        <Separator orientation="vertical" className="mx-1 h-6" />

        {/* Delete */}
        <ToolbarButton
          icon={Trash2}
          label="Delete Note"
          shortcut="Del"
          onClick={deleteNote}
          disabled={!noteSelected}
        />

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
                <span className="text-xs font-mono font-bold">
                  {"1/" + key}
                </span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {label} note
              <kbd className="ml-1.5 text-[10px] font-mono opacity-60">
                {key}
              </kbd>
            </TooltipContent>
          </Tooltip>
        ))}

        <Separator orientation="vertical" className="mx-1 h-6" />

        {/* Note info */}
        {selectedNoteInfo && (
          <div className="flex items-center gap-1.5 px-2 text-xs text-muted-foreground">
            <Music className="h-3.5 w-3.5" />
            <span className="font-mono">{selectedNoteInfo}</span>
          </div>
        )}

        {/* Spacer */}
        <div className="flex-1" />

        {/* Save */}
        <Button
          variant="default"
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

      {/* Split view: PDF + OSMD */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* PDF viewer */}
        {pdfUrl && (
          <div className="w-1/2 border-r">
            <iframe
              src={pdfUrl}
              title="Original PDF"
              className="w-full h-full border-0"
            />
          </div>
        )}

        {/* OSMD score */}
        <div className={cn("relative overflow-auto", pdfUrl ? "w-1/2" : "w-full")}>
          {isRendering && (
            <div className="absolute inset-0 flex items-center justify-center bg-background/80 z-10">
              <div className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin" />
                <span className="text-sm">Rendering score...</span>
              </div>
            </div>
          )}
          <div ref={containerRef} className="p-4" />
        </div>
      </div>
    </div>
  );
}
