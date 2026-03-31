/**
 * lyricsParser.ts
 *
 * Extracts and parses lyrics from MusicXML documents.
 * Handles syllabic types and multiple verses.
 */

export interface LyricsParseResult {
  /** Lyrics grouped by measure number (1-based) */
  measures: Array<{
    measure: number;
    text: string;
  }>;
  /** Full concatenated lyrics text (all verses combined) */
  fullText: string;
}

/**
 * Extract lyrics from MusicXML and group them by measure.
 * Handles syllabic types (single, begin, middle, end) to reconstruct words.
 * Supports multiple verses (verse number = lyric number attribute).
 *
 * @param musicxml - MusicXML string
 * @returns Object with per-measure lyrics and full text
 */
export function parseLyricsFromMusicXML(musicxml: string): LyricsParseResult {
  try {
    const doc = new DOMParser().parseFromString(musicxml, "text/xml");

    // Find all notes in the score
    const notes = Array.from(doc.querySelectorAll("note"));
    if (!notes.length) {
      return { measures: [], fullText: "" };
    }

    // Map: measure number → { verse number → text parts }
    const measureLyricsMap = new Map<number, Map<number, string[]>>();

    let currentMeasure = 0;

    for (const note of notes) {
      // Update current measure when we encounter a new measure marker
      const measureEl = note.closest("measure");
      if (measureEl) {
        const measureNum = measureEl.getAttribute("number");
        if (measureNum) {
          currentMeasure = parseInt(measureNum, 10);
        }
      }

      // Find all lyric elements in this note
      const lyrics = Array.from(note.querySelectorAll("lyric"));

      for (const lyric of lyrics) {
        const verseNum = parseInt(lyric.getAttribute("number") ?? "1", 10);
        const textEl = lyric.querySelector("text");
        const syllabicEl = lyric.querySelector("syllabic");

        if (!textEl || !textEl.textContent) continue;

        const text = textEl.textContent;
        const syllabic = syllabicEl?.textContent ?? "single";

        // Initialize measure entry if needed
        if (!measureLyricsMap.has(currentMeasure)) {
          measureLyricsMap.set(currentMeasure, new Map());
        }
        const verseMap = measureLyricsMap.get(currentMeasure)!;

        // Initialize verse array if needed
        if (!verseMap.has(verseNum)) {
          verseMap.set(verseNum, []);
        }
        const textParts = verseMap.get(verseNum)!;

        // Reconstruct words based on syllabic type
        if (syllabic === "single" || syllabic === "end") {
          // Complete word
          if (syllabic === "end" && textParts.length > 0) {
            // Append to previous partial word
            textParts[textParts.length - 1] += text;
          } else {
            textParts.push(text);
          }
        } else if (syllabic === "begin") {
          // Start of a word
          textParts.push(text);
        } else if (syllabic === "middle") {
          // Middle of a word
          if (textParts.length > 0) {
            textParts[textParts.length - 1] += text;
          } else {
            textParts.push(text);
          }
        }
      }
    }

    // Convert map to array format
    const measures: Array<{ measure: number; text: string }> = [];
    const verseTexts: Map<number, string[]> = new Map();

    // Sort by measure number
    const sortedMeasures = Array.from(measureLyricsMap.entries())
      .sort((a, b) => a[0] - b[0]);

    for (const [measureNum, verseMap] of sortedMeasures) {
      // Combine all verses for this measure with a space separator
      const verseNumbers = Array.from(verseMap.keys()).sort((a, b) => a - b);

      for (const verseNum of verseNumbers) {
        const textParts = verseMap.get(verseNum)!;
        const verseText = textParts.join(" ");

        if (!verseTexts.has(verseNum)) {
          verseTexts.set(verseNum, []);
        }
        verseTexts.get(verseNum)!.push(verseText);
      }

      // For the measures array, use verse 1 (primary) or first available
      const primaryVerse = verseMap.get(1) || verseMap.get(Array.from(verseMap.keys())[0]);
      if (primaryVerse) {
        measures.push({
          measure: measureNum,
          text: primaryVerse.join(" "),
        });
      }
    }

    // Build full text: concatenate all verses
    const allVerseTexts: string[] = [];
    const verseNumbers = Array.from(verseTexts.keys()).sort((a, b) => a - b);
    for (const verseNum of verseNumbers) {
      const verseParts = verseTexts.get(verseNum)!;
      allVerseTexts.push(verseParts.join(" "));
    }
    const fullText = allVerseTexts.join("\n\n");

    return { measures, fullText };
  } catch (err) {
    console.error("Error parsing lyrics from MusicXML:", err);
    return { measures: [], fullText: "" };
  }
}
