"""
Music Processing Service for Choir Voice Player
Handles OMR, MusicXML parsing, voice detection, and MIDI generation
"""

import logging
import os
import re
import shutil
import tempfile
import json
from typing import Dict, List, Optional, Tuple
import asyncio
import base64
import copy

logging.basicConfig(
    level=logging.getLevelName(os.environ.get("LOG_LEVEL", "INFO")),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("music_processor")

# OMR and Music Processing
from google import genai
from google.genai import types as genai_types
from music21 import converter, stream, note, chord, clef, instrument
import fitz  # PyMuPDF — self-contained PDF renderer, no external binaries (no poppler)
from dotenv import load_dotenv

load_dotenv()

# Force the google-genai SDK to use the Gemini Developer API (generativelanguage.googleapis.com)
# rather than Vertex AI (aiplatform.googleapis.com). Without this, the SDK silently switches to
# Vertex AI when GOOGLE_CLOUD_PROJECT or GOOGLE_APPLICATION_CREDENTIALS are present in the
# environment (e.g. from a prior `gcloud` setup), which rejects plain API keys with a 401.
os.environ["GOOGLE_GENAI_USE_VERTEXAI"] = "false"

# Build Gemini client (lazy: only instantiated if the key is present)
GENAI_API_KEY = os.environ.get("GEMINI_API_KEY")
# Timeout for Gemini API calls, in seconds (env var uses human-readable seconds;
# the google-genai SDK HttpOptions.timeout field is in *milliseconds*).
_GEMINI_TIMEOUT_S = int(os.environ.get("GEMINI_TIMEOUT", "120"))
GENAI_CLIENT: "genai.Client | None" = None
if GENAI_API_KEY:
    GENAI_CLIENT = genai.Client(
        api_key=GENAI_API_KEY,
        http_options={"timeout": _GEMINI_TIMEOUT_S * 1000},  # convert s → ms
    )
else:
    logger.warning("GEMINI_API_KEY not found. PDF OMR will not work.")

# Maximum number of PDF pages to send to Gemini in one request.
# Large PDFs risk hitting token limits and timeouts.
PDF_MAX_PAGES = int(os.environ.get("PDF_MAX_PAGES", "20"))

# DPI used when rasterising PDF pages for Gemini Vision.
# 150 DPI is sufficient for OCR and keeps JPEG payloads small.
# PDF native resolution is 72 pt/inch, so scale = DPI / 72.
PDF_RENDER_DPI = int(os.environ.get("PDF_RENDER_DPI", "150"))

VALID_VOICE_TYPES = {"soprano", "alto", "tenor", "bass", "other"}


class VoiceType:
    SOPRANO = "soprano"
    ALTO = "alto"
    TENOR = "tenor"
    BASS = "bass"
    OTHER = "other"


class MusicProcessor:
    """Main processor for sheet music analysis and MIDI generation"""

    def __init__(self):
        # Practical choral pitch ranges (MIDI note numbers) — from SATB notation reference.
        # Soprano C4–A5 (60–81), Alto G3–D5 (55–74), Tenor C3–G4 sounding (48–67),
        # Bass E2–C4 (40–60).  All configurable via environment variables.
        self.VOICE_RANGES = {
            VoiceType.SOPRANO: self._parse_range(os.environ.get("SOPRANO_RANGE", "60,81")),  # C4–A5
            VoiceType.ALTO:    self._parse_range(os.environ.get("ALTO_RANGE",    "55,74")),  # G3–D5
            VoiceType.TENOR:   self._parse_range(os.environ.get("TENOR_RANGE",  "48,67")),  # C3–G4 sounding
            VoiceType.BASS:    self._parse_range(os.environ.get("BASS_RANGE",   "40,60")),  # E2–C4
        }

        # Overlap threshold for voice detection (default 30%)
        self.OVERLAP_THRESHOLD = float(os.environ.get("VOICE_OVERLAP_THRESHOLD", "0.3"))

        self.temp_dir = tempfile.mkdtemp()

    def _parse_range(self, range_str):
        """Parse a range string like '60,81' into a tuple (60, 81)"""
        try:
            parts = range_str.split(',')
            return (int(parts[0]), int(parts[1]))
        except (ValueError, IndexError):
            logger.warning("Invalid range format %r, using default (0, 127)", range_str)
            return (0, 127)

    def cleanup(self):
        """Clean up temporary directory"""
        if os.path.exists(self.temp_dir):
            shutil.rmtree(self.temp_dir, ignore_errors=True)

    def __enter__(self):
        """Context manager entry"""
        return self

    def __exit__(self, *_):
        """Context manager exit — always clean up temp files"""
        self.cleanup()
        return False  # don't suppress exceptions

    def __del__(self):
        """Destructor fallback (unreliable — prefer context manager)"""
        self.cleanup()

    def process_pdf(self, pdf_path: str) -> str:
        """
        Convert PDF to MusicXML using Gemini Vision OMR
        Returns path to generated MusicXML file
        """
        # Input validation
        if not os.path.exists(pdf_path):
            raise ValueError(f"PDF file not found: {pdf_path}")
        if not os.path.isfile(pdf_path):
            raise ValueError(f"Path is not a file: {pdf_path}")
        if not pdf_path.lower().endswith('.pdf'):
            raise ValueError(f"File must be a PDF: {pdf_path}")

        if GENAI_CLIENT is None:
            raise RuntimeError("GEMINI_API_KEY is not set")

        # Render PDF pages to JPEG bytes using PyMuPDF (no external binaries needed).
        # scale = DPI / 72 because PDF native resolution is 72 pt/inch.
        scale = PDF_RENDER_DPI / 72.0
        mat = fitz.Matrix(scale, scale)

        doc = fitz.open(pdf_path)
        total_pages = len(doc)

        if total_pages == 0:
            raise ValueError("Could not extract pages from PDF")

        page_limit = min(total_pages, PDF_MAX_PAGES)
        if total_pages > PDF_MAX_PAGES:
            logger.warning(
                "PDF has %d pages; only the first %d will be processed.",
                total_pages, PDF_MAX_PAGES,
            )

        # Render each page to JPEG bytes (80% quality balances size vs. detail)
        jpeg_pages: list = []
        for page_num in range(page_limit):
            pix = doc[page_num].get_pixmap(matrix=mat)
            jpeg_pages.append(pix.tobytes("jpeg", jpg_quality=80))
        doc.close()

        logger.info(
            "Running Gemini Vision OMR on %s (%d/%d page(s))",
            pdf_path, len(jpeg_pages), total_pages,
        )

        try:
            model_name = os.environ.get("GEMINI_MODEL_NAME", "gemini-2.0-flash")

            page_note = (
                f"This score spans {len(images)} page(s) — all pages are provided in order."
                if total_pages <= PDF_MAX_PAGES else
                f"The first {len(images)} of {total_pages} pages are provided in order."
            )

            prompt = f"""You are an expert music engraver and SATB choral score transcriber.
Transcribe this SATB choir sheet music into valid MusicXML 3.1 (score-partwise).
{page_note}

=== STEP 1: IDENTIFY THE SCORE FORMAT ===
Determine the layout before transcribing:
• SHORT SCORE (most common) — 2 staves per system:
  - Treble staff: Soprano (stems UP ↑) + Alto (stems DOWN ↓) sharing one staff
  - Bass staff:   Tenor  (stems UP ↑) + Bass  (stems DOWN ↓) sharing one staff
  - Looks identical to a piano grand staff — the key difference is two voices per staff
• OPEN SCORE — 4 separate staves per system (one per voice)
• PIANO-VOCAL SCORE — choral staves on top + piano grand staff below.
  Transcribe ONLY the choral parts. IGNORE the piano staves entirely.

=== STEP 2: VOICE SEPARATION (SHORT SCORE RULE) ===
In short score, stem direction is the ONLY authoritative signal:
• Treble staff, stem UP   → Soprano  (range C4–A5, sounds at written pitch)
• Treble staff, stem DOWN → Alto     (range G3–D5, sounds at written pitch)
• Bass staff,   stem UP   → Tenor    (range C3–G4 SOUNDING, see tenor rule below)
• Bass staff,   stem DOWN → Bass     (range E2–C4, sounds at written pitch)
CRITICAL: Do NOT assign notes by pitch position — a soprano note on a low ledger
line still has stem UP. Voice crossing (alto above soprano momentarily) is valid;
always follow the stem, never the pitch height.
When both voices sing the same pitch (unison): one notehead with TWO stems (one up,
one down) — assign that pitch to BOTH parts.

=== STEP 3: TENOR OCTAVE RULE ===
The tenor sounds ONE OCTAVE LOWER than written when using the octave treble clef
(treble clef with a small "8" below the clef symbol).
• Encode this with: <transpose><diatonic>0</diatonic><chromatic>-12</chromatic>
  <octave-change>-1</octave-change></transpose> inside the tenor part's <attributes>.
• Written C5 on the tenor staff → sounds as C4 (middle C).
• If no "8" is visible but the staff is clearly tenor range (C3–G4 sounding),
  still apply the -12 transpose element — this is standard practice.
• In short score the tenor is on the BASS staff at sounding pitch — no transposition.

=== STEP 4: LYRICS ===
• Each lyric syllable aligns with exactly one note.
• Hyphens (-) between syllables of one word; extender lines after the last syllable
  of a word sustained over multiple notes (encode as <lyric> with syllabic="end").
• In short score: lyrics below the treble staff belong to Alto; lyrics between
  the staves or above the bass staff belong to Tenor.
• If all four voices share identical text at the same rhythm, it may appear only
  once — duplicate it to all four parts in the output.

=== STEP 5: OUTPUT REQUIREMENTS ===
• Produce EXACTLY FOUR <part> elements: Soprano, Alto, Tenor, Bass.
• Each part contains exactly ONE voice (voice number 1 throughout).
• Preserve ALL notes, rests, ties, slurs, dynamics, articulations, fermatas,
  tempo markings, key signatures, and time signatures across ALL provided pages
  in order.
• Return ONLY the raw MusicXML text. No markdown fences, no prose, no explanations.
• The response MUST start with <?xml and end with </score-partwise>."""

            # Wrap pre-rendered JPEG bytes as Gemini content parts
            image_parts = [
                genai_types.Part.from_bytes(data=jpeg_bytes, mime_type="image/jpeg")
                for jpeg_bytes in jpeg_pages
            ]

            # Send all pages to Gemini in one request
            response = GENAI_CLIENT.models.generate_content(
                model=model_name,
                contents=[prompt, *image_parts],
            )
            content = response.text

            # Strip any markdown code fences Gemini might add despite instructions.
            # Handle both ```xml ... ``` and ``` ... ``` variants robustly.
            fence_match = re.search(r"```(?:xml)?\s*([\s\S]*?)```", content)
            if fence_match:
                content = fence_match.group(1).strip()

            # Find the XML start even if there is leading prose
            if not content.startswith("<?xml") and not content.startswith("<score-partwise"):
                start_idx = content.find("<?xml")
                if start_idx == -1:
                    start_idx = content.find("<score-partwise")
                if start_idx != -1:
                    content = content[start_idx:]
                else:
                    raise ValueError("Gemini did not return valid XML start tag")

            output_path = os.path.join(self.temp_dir, "score.musicxml")
            with open(output_path, "w", encoding="utf-8") as f:
                f.write(content)

            # Validate with music21
            try:
                converter.parse(output_path)
            except Exception as e:
                raise RuntimeError(f"Generated MusicXML is invalid: {str(e)}")

            return output_path

        except Exception as e:
            logger.error("Gemini OMR failed: %s", e)
            raise RuntimeError(f"OMR processing failed: {str(e)}")

    # ------------------------------------------------------------------
    # Short-score multi-voice helpers
    # ------------------------------------------------------------------

    def _get_voice_ids(self, part) -> List[int]:
        """Return sorted list of numeric voice IDs present in this part.

        Returns an empty list when the part has no explicit Voice sub-streams
        (i.e. the entire part is a single-voice open-score staff).
        """
        voice_ids: set = set()
        for measure in part.getElementsByClass(stream.Measure):
            for voice_obj in measure.voices:
                try:
                    voice_ids.add(int(voice_obj.id))
                except (ValueError, TypeError):
                    pass
        return sorted(voice_ids)

    def _get_voice_flat_notes(self, part, voice_id: int) -> list:
        """Return a flat list of NoteRest elements belonging to one voice ID."""
        elements = []
        for measure in part.getElementsByClass(stream.Measure):
            for voice_obj in measure.voices:
                try:
                    if int(voice_obj.id) == voice_id:
                        for elem in voice_obj.flatten().notesAndRests:
                            elements.append(elem)
                        break
                except (ValueError, TypeError):
                    pass
        return elements

    def _extract_voice_as_part(self, source_part, voice_id: int):
        """Extract a single Voice stream from a multi-voice Part.

        Returns a new stream.Part containing only the notes/rests from
        *voice_id*, with measure structure and clef/key/time attributes
        preserved.  Missing voice measures are filled with whole rests so
        that the metric grid stays intact for MIDI output.
        """
        new_part = stream.Part()
        new_part.partName = source_part.partName

        for element in source_part:
            if isinstance(element, stream.Measure):
                new_measure = stream.Measure(number=element.number)
                # Copy structural attributes
                for attr_cls in ('Clef', 'KeySignature', 'TimeSignature', 'Barline'):
                    for attr in element.getElementsByClass(attr_cls):
                        new_measure.append(copy.deepcopy(attr))

                target_voice = None
                for v in element.voices:
                    try:
                        if int(v.id) == voice_id:
                            target_voice = v
                            break
                    except (ValueError, TypeError):
                        pass

                if target_voice:
                    for elem in target_voice:
                        new_measure.append(copy.deepcopy(elem))
                else:
                    # Voice absent this measure — whole rest to fill
                    new_measure.append(note.Rest(
                        quarterLength=element.duration.quarterLength or 4.0
                    ))

                new_part.append(new_measure)
            elif not isinstance(element, stream.Voice):
                new_part.append(copy.deepcopy(element))

        return new_part

    def analyze_musicxml(self, musicxml_path: str) -> Dict:
        """Analyze MusicXML file and detect voices.

        Handles both open-score (one part per voice) and short-score
        (Soprano+Alto on treble, Tenor+Bass on bass) formats.  Multi-voice
        parts are expanded so each voice gets its own sequential index,
        keeping the API backward-compatible with the frontend.

        Each entry in `parts` includes extra metadata used by
        `generate_midi_files` to correctly extract voices:
          part_index  — index into score.parts (may repeat for short score)
          voice_id    — integer voice ID within the part, or null for open score
          score_format — "short_score" | "open_score"
        """
        score = converter.parse(musicxml_path)
        parts_info = []
        linear_idx = 0

        for part_idx, part in enumerate(score.parts):
            part_name = part.partName or f"Part {part_idx + 1}"
            flat = part.flatten()
            clef_type = self._detect_clef(flat)

            # Tenor in open score uses treble8vb: pitches are written one
            # octave higher than they sound.  Correct before voice detection
            # unless music21 already applied a <transpose> from the file.
            has_transpose = getattr(part, 'transposition', None) is not None
            octave_correction = -12 if (clef_type == "treble8vb" and not has_transpose) else 0

            voice_ids = self._get_voice_ids(part)

            if len(voice_ids) > 1:
                # Short-score format: expand each voice as a separate entry.
                # Voice 1 = upper (stem-up = Soprano/Tenor),
                # Voice 2 = lower (stem-down = Alto/Bass).
                for voice_position, voice_id in enumerate(voice_ids, start=1):
                    voice_elements = self._get_voice_flat_notes(part, voice_id)
                    note_count = sum(
                        1 for e in voice_elements
                        if isinstance(e, (note.Note, chord.Chord))
                    )
                    # Build a temporary flat-like list for pitch analysis
                    pitch_range = self._analyze_pitch_range_from_elements(
                        voice_elements, octave_correction
                    )
                    # Infer display name from clef + voice position
                    inferred = {
                        ("treble",    1): "Soprano", ("treble",    2): "Alto",
                        ("treble8vb", 1): "Soprano", ("treble8vb", 2): "Alto",
                        ("bass",      1): "Tenor",   ("bass",      2): "Bass",
                    }.get((clef_type, voice_position), f"Voice {voice_id}")
                    voice_name = f"{part_name} ({inferred})"

                    detected_voice = self._detect_voice_type(
                        voice_name, clef_type, pitch_range,
                        voice_position=voice_position,
                    )
                    parts_info.append({
                        "index":        linear_idx,
                        "part_index":   part_idx,
                        "voice_id":     voice_id,
                        "name":         voice_name,
                        "clef":         clef_type,
                        "pitch_range":  pitch_range,
                        "detected_voice": detected_voice,
                        "note_count":   note_count,
                        "score_format": "short_score",
                    })
                    linear_idx += 1
            else:
                # Open-score format: one voice per part.
                pitch_range = self._analyze_pitch_range(flat, octave_correction)
                detected_voice = self._detect_voice_type(
                    part_name, clef_type, pitch_range
                )
                parts_info.append({
                    "index":        linear_idx,
                    "part_index":   part_idx,
                    "voice_id":     None,
                    "name":         part_name,
                    "clef":         clef_type,
                    "pitch_range":  pitch_range,
                    "detected_voice": detected_voice,
                    "note_count":   len(flat.notes),
                    "score_format": "open_score",
                })
                linear_idx += 1

        return {
            "parts":       parts_info,
            "total_parts": len(parts_info),
        }

    def _analyze_pitch_range_from_elements(
        self,
        elements: list,
        octave_correction: int = 0,
    ) -> Optional[Tuple[int, int]]:
        """Like `_analyze_pitch_range` but operates on a plain list of NoteRest objects."""
        pitches = []
        for element in elements:
            if isinstance(element, note.Note):
                pitches.append(element.pitch.midi + octave_correction)
            elif isinstance(element, chord.Chord):
                pitches.extend([p.midi + octave_correction for p in element.pitches])
        if not pitches:
            return None
        return (min(pitches), max(pitches))

    def _detect_clef(self, flat) -> str:
        """Detect the primary clef used in a part.

        Accepts either a Part or a pre-flattened stream to avoid redundant
        flatten() calls when the caller has already flattened.

        Returns one of: "treble", "treble8vb", "bass", "alto", "tenor_c", "unknown".
        "treble8vb" = octave treble clef (small "8" below) — tenor in open score;
        sounds one octave lower than written.
        "tenor_c"   = C clef on 4th line — historical open-score tenor notation.

        IMPORTANT: Treble8vbClef is a subclass of TrebleClef, so it MUST be
        checked first, otherwise it would be mis-classified as plain "treble".
        """
        clefs = flat.getElementsByClass(clef.Clef)
        if clefs:
            first_clef = clefs[0]
            # Check subclass Treble8vbClef before the parent TrebleClef
            if isinstance(first_clef, clef.Treble8vbClef):
                return "treble8vb"
            elif isinstance(first_clef, clef.TrebleClef):
                return "treble"
            elif isinstance(first_clef, clef.BassClef):
                return "bass"
            elif isinstance(first_clef, clef.AltoClef):
                return "alto"
            elif isinstance(first_clef, clef.TenorClef):
                return "tenor_c"  # C clef on 4th line
        return "unknown"

    def _analyze_pitch_range(
        self,
        flat,
        octave_correction: int = 0,
    ) -> Optional[Tuple[int, int]]:
        """Analyze the pitch range of a part (returns MIDI note numbers).

        Accepts either a Part or a pre-flattened stream to avoid redundant
        flatten() calls when the caller has already flattened.

        octave_correction: semitone shift to apply to every pitch before
        computing the range.  Pass -12 for tenor parts that use the octave
        treble clef (treble8vb) without a MusicXML <transpose> element, so
        the returned range reflects sounding pitch rather than written pitch.
        """
        pitches = []

        for element in flat.notesAndRests:
            if isinstance(element, note.Note):
                pitches.append(element.pitch.midi + octave_correction)
            elif isinstance(element, chord.Chord):
                pitches.extend([p.midi + octave_correction for p in element.pitches])

        if not pitches:
            return None

        return (min(pitches), max(pitches))

    def _detect_voice_type(
        self,
        part_name: str,
        clef_type: str,
        pitch_range: Optional[Tuple[int, int]],
        voice_position: Optional[int] = None,
    ) -> str:
        """Detect voice type using part name, clef, pitch range, and stem-direction hint.

        voice_position: 1 = upper voice (stem-up in short score), 2 = lower voice
        (stem-down).  When set, it is used as a tiebreaker between name-based
        detection and pitch-range heuristics — reflecting the SATB rule that
        stem direction is the authoritative signal in short scores.
        """
        part_name_lower = part_name.lower().strip()

        # --- 1. Part name (highest confidence) ---
        # Word-boundary patterns prevent "Piano" matching "a", etc.
        soprano_patterns = [r'\bsoprano\b', r'\bsop\b', r'\bsopr\b', r'^s(?=[.\d]|$)']
        alto_patterns    = [r'\balto\b', r'\balt\b', r'\bcontr\b', r'\bcounter\b', r'^a(?=[.\d]|$)']
        tenor_patterns   = [r'\btenor\b', r'\bten\b', r'^t(?=[.\d]|$)']
        bass_patterns    = [r'\bbass\b', r'\bbas\b', r'\bbari\b', r'\bbaritone\b', r'\bbar\b', r'^b(?=[.\d]|$)']

        if any(re.search(p, part_name_lower) for p in soprano_patterns):
            return VoiceType.SOPRANO
        if any(re.search(p, part_name_lower) for p in alto_patterns):
            return VoiceType.ALTO
        if any(re.search(p, part_name_lower) for p in tenor_patterns):
            return VoiceType.TENOR
        if any(re.search(p, part_name_lower) for p in bass_patterns):
            return VoiceType.BASS

        # --- 2. Stem-direction + clef (short-score positional hint) ---
        # In short score, stem direction is the authoritative signal for voice
        # identity (§5 of the SATB reference).  Use it when no name match found.
        if voice_position is not None:
            if clef_type in ("treble", "treble8vb", "unknown"):
                return VoiceType.SOPRANO if voice_position == 1 else VoiceType.ALTO
            elif clef_type == "bass":
                return VoiceType.TENOR if voice_position == 1 else VoiceType.BASS
            elif clef_type == "tenor_c":
                return VoiceType.TENOR

        # --- 3. Pitch range overlap (statistical match) ---
        if pitch_range:
            min_pitch, max_pitch = pitch_range
            best_match = VoiceType.OTHER
            best_score = 0.0

            for voice_type, (voice_min, voice_max) in self.VOICE_RANGES.items():
                overlap_min = max(min_pitch, voice_min)
                overlap_max = min(max_pitch, voice_max)
                if overlap_max >= overlap_min:
                    overlap_range = overlap_max - overlap_min
                    score = overlap_range / (max_pitch - min_pitch + 1)
                    if score > best_score:
                        best_score = score
                        best_match = voice_type

            if best_score > self.OVERLAP_THRESHOLD:
                return best_match

            # Moderate match: confirm with clef agreement
            treble_voices = {VoiceType.SOPRANO, VoiceType.ALTO}
            bass_voices   = {VoiceType.TENOR, VoiceType.BASS}
            if best_score > self.OVERLAP_THRESHOLD / 2:
                if best_match in treble_voices and clef_type in ("treble", "treble8vb", "alto"):
                    return best_match
                if best_match in bass_voices and clef_type in ("bass", "tenor_c"):
                    return best_match

        # --- 4. Clef fallback ---
        clef_defaults = {
            "treble":   VoiceType.SOPRANO,
            "treble8vb": VoiceType.TENOR,  # open-score tenor uses 8vb treble
            "bass":     VoiceType.BASS,
            "alto":     VoiceType.ALTO,
            "tenor_c":  VoiceType.TENOR,
        }
        return clef_defaults.get(clef_type, VoiceType.OTHER)

    def _build_voice_index_map(self, score) -> Dict[str, Tuple]:
        """Build a mapping from linear voice index (string key) to (part_idx, voice_id).

        Mirrors the expansion logic in `analyze_musicxml` so that the integer
        keys stored in voice_assignments (e.g. "0", "1", "2", "3") correctly
        resolve to either a whole part (voice_id=None) or a specific Voice
        sub-stream within a multi-voice part.
        """
        mapping: Dict[str, Tuple] = {}
        linear_idx = 0
        for part_idx, part in enumerate(score.parts):
            voice_ids = self._get_voice_ids(part)
            if len(voice_ids) > 1:
                for vid in voice_ids:
                    mapping[str(linear_idx)] = (part_idx, vid)
                    linear_idx += 1
            else:
                mapping[str(linear_idx)] = (part_idx, None)
                linear_idx += 1
        return mapping

    def generate_midi_files(
        self,
        musicxml_path: str,
        voice_assignments: Dict[int, str],
        output_dir: str
    ) -> Dict[str, str]:
        """Generate separate MIDI files for each SATB voice.

        Supports both open-score MusicXML (one part per voice) and short-score
        MusicXML (two voices per staff).  voice_assignments keys are sequential
        integer strings ("0", "1", …) that map to logical voices as defined by
        `analyze_musicxml`, not directly to MusicXML part indices.

        Returns a dict mapping voice type (and "all") to MIDI file paths.
        """
        score = converter.parse(musicxml_path)

        # Build the same linear-index → (part_idx, voice_id) map used by analyze_musicxml
        voice_index_map = self._build_voice_index_map(score)

        # Group extracted part/voice streams by target voice type
        voice_parts: Dict[str, list] = {}
        other_entries: list = []  # (part_stream,) for fallback auto-detection

        for str_idx, (part_idx, voice_id) in voice_index_map.items():
            voice_type = voice_assignments.get(str_idx,
                         voice_assignments.get(int(str_idx), VoiceType.OTHER))

            raw_part = score.parts[part_idx]

            # Extract the correct sub-stream for short-score voices
            if voice_id is not None:
                part_stream = self._extract_voice_as_part(raw_part, voice_id)
            else:
                part_stream = raw_part

            if voice_type == VoiceType.OTHER:
                other_entries.append(part_stream)
            else:
                voice_parts.setdefault(voice_type, []).append(part_stream)

        # Fallback: auto-detect voices from OTHER entries if no SATB assignment was made
        satb_voices = {VoiceType.SOPRANO, VoiceType.ALTO, VoiceType.TENOR, VoiceType.BASS}
        if not any(v in voice_parts for v in satb_voices) and other_entries:
            logger.info(
                "No SATB voice assignments found — falling back to automatic "
                "detection for MIDI generation."
            )
            for part_stream in other_entries:
                flat = part_stream.flatten()
                clef_type = self._detect_clef(flat)
                pitch_range = self._analyze_pitch_range(flat)
                part_name = getattr(part_stream, 'partName', None) or "Part"
                detected = self._detect_voice_type(part_name, clef_type, pitch_range)
                if detected != VoiceType.OTHER:
                    voice_parts.setdefault(detected, []).append(part_stream)

        # Write one MIDI file per SATB voice
        midi_files: Dict[str, str] = {}

        for voice_type, parts in voice_parts.items():
            if voice_type == VoiceType.OTHER:
                continue

            voice_score = stream.Score()
            for part in parts:
                part_copy = copy.deepcopy(part)
                part_copy.insert(0, self._get_instrument_for_voice(voice_type))
                voice_score.append(part_copy)

            midi_path = os.path.join(output_dir, f"{voice_type}.mid")
            try:
                voice_score.write('midi', fp=midi_path)
            except Exception as e:
                logger.warning("Failed to write MIDI for voice %r: %s", voice_type, e)
                continue

            midi_files[voice_type] = midi_path

        # Combined MIDI with all voices from the original parsed score
        combined_path = os.path.join(output_dir, "all_voices.mid")
        score.write('midi', fp=combined_path)
        midi_files["all"] = combined_path

        return midi_files

    def _get_instrument_for_voice(self, voice_type: str) -> instrument.Instrument:
        """Get appropriate instrument for a voice type"""
        # Use vocal instruments for each voice
        if voice_type == VoiceType.SOPRANO:
            return instrument.Soprano()
        elif voice_type == VoiceType.ALTO:
            return instrument.Alto()
        elif voice_type == VoiceType.TENOR:
            return instrument.Tenor()
        elif voice_type == VoiceType.BASS:
            return instrument.Bass()
        else:
            return instrument.Vocalist()

# FastAPI endpoints
from fastapi import FastAPI, File, UploadFile, HTTPException, Form, Depends, Header
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

app = FastAPI(title="Choir Voice Player - Music Processing Service")

# Enable CORS - configurable origins
ALLOWED_ORIGINS_STR = os.getenv("ALLOWED_ORIGINS", "*")
ALLOWED_ORIGINS = [origin.strip() for origin in ALLOWED_ORIGINS_STR.split(",")] if ALLOWED_ORIGINS_STR != "*" else ["*"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# B-10: Internal service token — when set, all /api/* endpoints require the
# caller (Node.js server) to send the matching X-Internal-Token header.
# This prevents unauthenticated direct access and Gemini API quota abuse.
INTERNAL_SERVICE_TOKEN = os.environ.get("INTERNAL_SERVICE_TOKEN", "")

if not INTERNAL_SERVICE_TOKEN:
    logger.warning(
        "INTERNAL_SERVICE_TOKEN is not set. "
        "The /api/* endpoints are accessible without authentication. "
        "Set this variable in production to match the Node.js server setting."
    )


async def verify_internal_token(x_internal_token: Optional[str] = Header(None)) -> None:
    """Validate the shared internal service token.

    Only enforced when INTERNAL_SERVICE_TOKEN is configured — allows the
    service to run unauthenticated in local development without extra setup.
    """
    if INTERNAL_SERVICE_TOKEN and x_internal_token != INTERNAL_SERVICE_TOKEN:
        raise HTTPException(status_code=403, detail="Forbidden: invalid internal service token")


def create_temp_processor():
    """Create a temporary processor instance for a single request"""
    return MusicProcessor()


@app.post("/api/process-pdf")
async def process_pdf(
    file: UploadFile = File(...),
    _: None = Depends(verify_internal_token),  # B-10: require internal auth
):
    """Process PDF sheet music using OMR"""
    if not file.filename.lower().endswith('.pdf'):
        raise HTTPException(400, "File must be a PDF")

    file_content = await file.read()
    if len(file_content) > 50 * 1024 * 1024:
        raise HTTPException(413, "File too large. Maximum size is 50MB")

    def _run():
        with create_temp_processor() as processor:
            # B-04: use a hardcoded safe filename — never trust the client-supplied
            # filename which could contain path traversal sequences (e.g. "../etc/passwd")
            pdf_path = os.path.join(processor.temp_dir, "input.pdf")
            with open(pdf_path, 'wb') as f:
                f.write(file_content)
            musicxml_path = processor.process_pdf(pdf_path)
            analysis = processor.analyze_musicxml(musicxml_path)
            with open(musicxml_path, 'r', encoding="utf-8") as f:
                musicxml_content = f.read()
            return {"success": True, "musicxml": musicxml_content, "analysis": analysis}

    try:
        result = await asyncio.to_thread(_run)
        return JSONResponse(result)
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Error processing PDF: %s", e)
        raise HTTPException(500, "Processing failed. Please try again later.")


@app.post("/api/process-musicxml")
async def process_musicxml(
    file: UploadFile = File(...),
    _: None = Depends(verify_internal_token),  # B-10: require internal auth
):
    """Process uploaded MusicXML file"""
    if not (file.filename.lower().endswith('.xml') or file.filename.lower().endswith('.musicxml') or file.filename.lower().endswith('.mxl')):
        raise HTTPException(400, "File must be MusicXML (.xml, .musicxml, or .mxl)")

    file_content = await file.read()
    if len(file_content) > 50 * 1024 * 1024:
        raise HTTPException(413, "File too large. Maximum size is 50MB")

    def _run():
        with create_temp_processor() as processor:
            # B-04: hardcoded safe filename prevents path traversal.
            # Detect compressed MusicXML (.mxl) by ZIP magic bytes (PK\x03\x04)
            # so music21 can decompress it correctly regardless of the client filename.
            is_mxl = file_content[:4] == b'PK\x03\x04'
            input_ext = ".mxl" if is_mxl else ".musicxml"
            musicxml_path = os.path.join(processor.temp_dir, f"input{input_ext}")
            with open(musicxml_path, 'wb') as f:
                f.write(file_content)
            analysis = processor.analyze_musicxml(musicxml_path)
            # Re-export as plain (uncompressed) MusicXML so the response is always
            # a UTF-8 string regardless of whether the upload was .mxl or .xml/.musicxml.
            if is_mxl:
                score_parsed = converter.parse(musicxml_path)
                plain_path = os.path.join(processor.temp_dir, "score_plain.musicxml")
                score_parsed.write('musicxml', fp=plain_path)
                with open(plain_path, 'r', encoding="utf-8") as f:
                    musicxml_content = f.read()
            else:
                with open(musicxml_path, 'r', encoding="utf-8") as f:
                    musicxml_content = f.read()
            return {"success": True, "musicxml": musicxml_content, "analysis": analysis}

    try:
        result = await asyncio.to_thread(_run)
        return JSONResponse(result)
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Error processing MusicXML: %s", e)
        raise HTTPException(500, "Analysis failed. Please try again later.")


@app.post("/api/generate-midi")
async def generate_midi(
    musicxml: str = Form(...),
    voice_assignments: str = Form(...),
    _: None = Depends(verify_internal_token),  # B-10: require internal auth
):
    """Generate MIDI files for each voice"""

    # Validate MusicXML content length
    if len(musicxml) > 50 * 1024 * 1024:  # 50MB
        raise HTTPException(413, "MusicXML content too large. Maximum size is 50MB")

    # Parse and validate voice assignments
    try:
        assignments = json.loads(voice_assignments)
    except json.JSONDecodeError:
        raise HTTPException(400, "Invalid voice_assignments JSON")

    if not isinstance(assignments, dict):
        raise HTTPException(400, "voice_assignments must be a JSON object")

    for key, val in assignments.items():
        if not isinstance(key, str):
            raise HTTPException(400, f"voice_assignments keys must be strings, got {type(key).__name__!r}")
        if not isinstance(val, str) or val not in VALID_VOICE_TYPES:
            raise HTTPException(
                400,
                f"Invalid voice type {val!r} for part {key!r}. "
                f"Must be one of: {', '.join(sorted(VALID_VOICE_TYPES))}"
            )

    def _run():
        with create_temp_processor() as processor:
            musicxml_path = os.path.join(processor.temp_dir, "score.musicxml")
            with open(musicxml_path, 'w', encoding="utf-8") as f:
                f.write(musicxml)
            output_dir = os.path.join(processor.temp_dir, "midi_output")
            os.makedirs(output_dir, exist_ok=True)
            midi_files = processor.generate_midi_files(musicxml_path, assignments, output_dir)
            midi_data = {}
            for voice_type, midi_path in midi_files.items():
                with open(midi_path, 'rb') as f:
                    midi_data[voice_type] = base64.b64encode(f.read()).decode('utf-8')
            return {"success": True, "midi_files": midi_data}

    try:
        result = await asyncio.to_thread(_run)
        return JSONResponse(result)
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Error generating MIDI: %s", e)
        raise HTTPException(500, "MIDI generation failed. Please try again later.")


@app.get("/health")
async def health_check():
    """Health check endpoint — intentionally unauthenticated so the Node.js
    server can probe it without needing to set up auth headers."""
    gemini_configured = bool(os.environ.get("GEMINI_API_KEY"))

    return {
        "status": "healthy",
        "gemini_configured": gemini_configured,
    }


if __name__ == "__main__":
    port = int(os.environ.get("PYTHON_SERVICE_PORT", 8001))
    uvicorn.run(app, host="0.0.0.0", port=port)
