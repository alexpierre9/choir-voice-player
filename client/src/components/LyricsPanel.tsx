/**
 * LyricsPanel.tsx
 *
 * A slide-in panel that displays lyrics synced with the music score.
 * Supports font size toggling and active measure highlighting.
 */

import { useEffect, useRef, useState } from "react";
import { X, ChevronUp, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { usePretextLyrics } from "@/hooks/usePretextLyrics";
import { useIsMobile } from "@/hooks/useMobile";

export interface LyricsPanelProps {
  /** Full lyrics text to display */
  lyrics: string;
  /** Whether the panel is open */
  isOpen: boolean;
  /** Called when the user closes the panel */
  onClose: () => void;
  /** Current active measure number (1-based), if in synced mode */
  activeMeasure?: number;
  /** Measure bounding boxes for synced highlighting */
  measureBounds?: Array<{ measure: number; x: number; width: number }>;
}

type FontSize = 14 | 16 | 18 | 20;

export default function LyricsPanel({
  lyrics,
  isOpen,
  onClose,
  activeMeasure,
  measureBounds,
}: LyricsPanelProps) {
  const isMobile = useIsMobile();
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [fontSize, setFontSize] = useState<FontSize>(16);

  // Container width: desktop sidebar is 300px, mobile is full width
  const containerWidth = isMobile ? 320 : 300;

  // Use Pretext to layout lyrics at current font size
  const { totalHeight, lines } = usePretextLyrics(lyrics, containerWidth, fontSize, measureBounds);

  // Auto-scroll to keep active measure visible
  useEffect(() => {
    if (!isOpen || activeMeasure === undefined || !scrollContainerRef.current) return;

    // Find the first line associated with the active measure
    const activeLineEl = scrollContainerRef.current.querySelector(
      `[data-measure="${activeMeasure}"]`,
    );

    if (activeLineEl) {
      activeLineEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [isOpen, activeMeasure]);

  if (!isOpen) return null;

  return (
    <>
      {/* Backdrop (mobile only, to close panel) */}
      {isMobile && (
        <div
          className="fixed inset-0 bg-black/20 z-40"
          onClick={onClose}
          aria-hidden="true"
        />
      )}

      {/* Panel container */}
      <div
        className={cn(
          "fixed z-50 flex flex-col bg-white dark:bg-slate-900 shadow-lg",
          isMobile
            ? // Mobile: bottom drawer, half screen
              "bottom-0 left-0 right-0 rounded-t-lg max-h-[50vh]"
            : // Desktop: right sidebar
              "right-0 top-0 bottom-0 w-80 rounded-none",
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b bg-muted/50">
          <h2 className="text-sm font-semibold">Lyrics</h2>

          <div className="flex items-center gap-1">
            {/* Font size controls */}
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setFontSize((prev) => Math.max(14, prev - 2) as FontSize)}
              disabled={fontSize === 14}
              title="Decrease font size"
            >
              <ChevronDown className="h-4 w-4" />
            </Button>

            <span className="text-xs font-mono px-2 py-1 rounded bg-muted">
              {fontSize}px
            </span>

            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setFontSize((prev) => Math.min(20, prev + 2) as FontSize)}
              disabled={fontSize === 20}
              title="Increase font size"
            >
              <ChevronUp className="h-4 w-4" />
            </Button>

            {/* Close button */}
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onClose}
              title="Close lyrics panel"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Lyrics content */}
        <div
          ref={scrollContainerRef}
          className="flex-1 overflow-y-auto p-4 text-base leading-relaxed"
          style={{
            fontFamily: 'ui-serif, Georgia, "Times New Roman", serif',
            fontSize: `${fontSize}px`,
            lineHeight: `${fontSize * 1.75}px`, // 28px at 16px, scales with font
          }}
        >
          {lines.length === 0 ? (
            <div className="text-muted-foreground italic text-center py-8">
              No lyrics available
            </div>
          ) : (
            <div style={{ height: totalHeight }}>
              {lines.map((line, idx) => (
                <span
                  key={idx}
                  data-measure={line.measure}
                  className={cn(
                    "block transition-colors duration-200",
                    line.measure === activeMeasure
                      ? "bg-blue-100 dark:bg-blue-950 px-2 rounded"
                      : "",
                  )}
                  style={{
                    position: "absolute",
                    top: `${line.y}px`,
                    left: "1rem",
                    right: "1rem",
                  }}
                >
                  {line.text}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
