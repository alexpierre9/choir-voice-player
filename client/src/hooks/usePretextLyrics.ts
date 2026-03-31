/**
 * usePretextLyrics.ts
 *
 * Hook that uses Pretext to layout lyrics text without DOM,
 * returning line positions for rendering and measure-based highlighting.
 */

import { useMemo } from "react";
import { prepareWithSegments, layoutWithLines } from "@chenglou/pretext";

export interface MeasureBound {
  measure: number;
  x: number;
  width: number;
}

export interface LayoutLine {
  text: string;
  y: number;
  measure?: number;
}

export interface UsePretextLyricsResult {
  totalHeight: number;
  lines: LayoutLine[];
}

const PADDING = 32;

/**
 * Use Pretext to layout lyrics text at a given container width.
 * Optionally sync to measures for per-measure highlighting.
 *
 * @param lyrics - Full lyrics text to layout
 * @param containerWidth - Width in pixels available for text flow
 * @param fontSize - Font size in pixels (default 16)
 * @param measureBounds - Optional: measure positions for synced highlighting
 * @returns Layout result: total height and positioned lines
 */
export function usePretextLyrics(
  lyrics: string,
  containerWidth: number,
  fontSize: number = 16,
  measureBounds?: MeasureBound[],
): UsePretextLyricsResult {
  return useMemo(() => {
    if (!lyrics || containerWidth <= 0) {
      return { totalHeight: 0, lines: [] };
    }

    try {
      const availableWidth = Math.max(containerWidth - PADDING, 100);
      const fontSpec = `${fontSize}px ui-serif, Georgia, "Times New Roman", serif`;
      const lineHeight = Math.round(fontSize * 1.75); // Generous line height for readability

      // Prepare text with Pretext (segments track the original text boundaries)
      const prepared = prepareWithSegments(lyrics, fontSpec);

      // Layout the text with lines
      const layoutResult = layoutWithLines(prepared, availableWidth, lineHeight);

      if (!layoutResult || !layoutResult.lines) {
        return { totalHeight: 0, lines: [] };
      }

      // Convert Pretext layout result to our format
      let currentY = 0;
      const lines: LayoutLine[] = layoutResult.lines.map((line) => {
        const layoutLine: LayoutLine = {
          text: line.text || "",
          y: currentY,
          measure: undefined,
        };
        currentY += lineHeight;
        return layoutLine;
      });

      // If measureBounds provided, attempt to map text to measures
      if (measureBounds && measureBounds.length > 0 && lines.length > 0) {
        // Distribute lines across measures sequentially
        const linesPerMeasure = Math.max(1, Math.floor(lines.length / measureBounds.length));
        let lineIdx = 0;

        for (const bound of measureBounds) {
          for (let i = 0; i < linesPerMeasure && lineIdx < lines.length; i++) {
            if (lines[lineIdx]) {
              lines[lineIdx].measure = bound.measure;
            }
            lineIdx++;
          }
        }

        // Assign remaining lines to last measure
        const lastMeasure = measureBounds[measureBounds.length - 1];
        while (lineIdx < lines.length) {
          if (lines[lineIdx]) {
            lines[lineIdx].measure = lastMeasure.measure;
          }
          lineIdx++;
        }
      }

      const totalHeight = layoutResult.height;

      return { totalHeight, lines };
    } catch (err) {
      console.error("Pretext layout error:", err);
      return { totalHeight: 0, lines: [] };
    }
  }, [lyrics, containerWidth, fontSize, measureBounds]);
}
