"""
Music Processing Service for Choir Voice Player
Handles OMR, MusicXML parsing, voice detection, and MIDI generation
"""

import os
import re
import shutil
import tempfile
import json
from typing import Dict, List, Optional, Tuple
import asyncio
import base64
import copy
import io

# OMR and Music Processing
from google import genai
from google.genai import types as genai_types
from music21 import converter, stream, note, chord, clef, instrument
from pdf2image import convert_from_path
from dotenv import load_dotenv

load_dotenv()

# Build Gemini client (lazy: only instantiated if the key is present)
GENAI_API_KEY = os.environ.get("GEMINI_API_KEY")
GENAI_CLIENT: "genai.Client | None" = None
if GENAI_API_KEY:
    GENAI_CLIENT = genai.Client(api_key=GENAI_API_KEY)
else:
    print("Warning: GEMINI_API_KEY not found. PDF OMR will not work.")

# Maximum number of PDF pages to send to Gemini in one request.
# Large PDFs risk hitting token limits and timeouts.
PDF_MAX_PAGES = int(os.environ.get("PDF_MAX_PAGES", "20"))

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
        # Pitch ranges for SATB voices (MIDI note numbers) - configurable via environment
        self.VOICE_RANGES = {
            VoiceType.SOPRANO: self._parse_range(os.environ.get("SOPRANO_RANGE", "60,81")),  # C4 to A5
            VoiceType.ALTO: self._parse_range(os.environ.get("ALTO_RANGE", "55,76")),       # G3 to E5
            VoiceType.TENOR: self._parse_range(os.environ.get("TENOR_RANGE", "48,69")),     # C3 to A4
            VoiceType.BASS: self._parse_range(os.environ.get("BASS_RANGE", "40,64")),       # E2 to E4
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
            print(f"Warning: Invalid range format '{range_str}', using default (0, 127)")
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

        # Convert PDF pages to images
        images = convert_from_path(pdf_path, dpi=300)

        if not images:
            raise ValueError("Could not extract images from PDF")

        total_pages = len(images)
        if total_pages > PDF_MAX_PAGES:
            print(f"Warning: PDF has {total_pages} pages; only the first {PDF_MAX_PAGES} will be processed.")
            images = images[:PDF_MAX_PAGES]

        print(f"Running Gemini Vision OMR on {pdf_path} ({len(images)}/{total_pages} page(s))...")

        try:
            model_name = os.environ.get("GEMINI_MODEL_NAME", "gemini-2.0-flash")

            page_note = (
                f"This score spans {len(images)} page(s) — all pages are provided in order."
                if total_pages <= PDF_MAX_PAGES else
                f"The first {len(images)} of {total_pages} pages are provided in order."
            )

            prompt = f"""Transcribe this SATB choir sheet music into valid MusicXML 3.1 (score-partwise).
{page_note}

Rules:
- Produce FOUR separate <part> elements with part names: Soprano, Alto, Tenor, Bass.
- If Soprano and Alto share one treble-clef staff, split them into two distinct parts.
- If Tenor and Bass share one bass-clef staff, split them into two distinct parts.
- Preserve every note, rest, rhythm, tie, slur, dynamic marking, tempo indication, lyric, key signature, and time signature across ALL pages, in order.
- Return ONLY the raw MusicXML. No markdown fences, no prose, no explanations.
- The response MUST start with <?xml and end with </score-partwise>."""

            # Convert PIL images to JPEG bytes for the new SDK
            image_parts = []
            for img in images:
                buf = io.BytesIO()
                img.save(buf, format="JPEG")
                image_parts.append(
                    genai_types.Part.from_bytes(data=buf.getvalue(), mime_type="image/jpeg")
                )

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
            print(f"Gemini OMR failed: {e}")
            raise RuntimeError(f"OMR processing failed: {str(e)}")

    def analyze_musicxml(self, musicxml_path: str) -> Dict:
        """
        Analyze MusicXML file and detect voices
        Returns structure with parts and automatic voice detection
        """
        score = converter.parse(musicxml_path)

        parts_info = []

        for part_idx, part in enumerate(score.parts):
            part_name = part.partName or f"Part {part_idx + 1}"

            # Flatten once and reuse across all analyses for this part
            flat = part.flatten()

            clef_type = self._detect_clef(flat)
            pitch_range = self._analyze_pitch_range(flat)
            detected_voice = self._detect_voice_type(part_name, clef_type, pitch_range)
            note_count = len(flat.notes)

            parts_info.append({
                "index": part_idx,
                "name": part_name,
                "clef": clef_type,
                "pitch_range": pitch_range,
                "detected_voice": detected_voice,
                "note_count": note_count,
            })

        return {
            "parts": parts_info,
            "total_parts": len(parts_info),
        }

    def _detect_clef(self, flat) -> str:
        """Detect the primary clef used in a part.

        Accepts either a Part or a pre-flattened stream to avoid redundant
        flatten() calls when the caller has already flattened.
        """
        clefs = flat.getElementsByClass(clef.Clef)
        if clefs:
            first_clef = clefs[0]
            if isinstance(first_clef, clef.TrebleClef):
                return "treble"
            elif isinstance(first_clef, clef.BassClef):
                return "bass"
            elif isinstance(first_clef, clef.AltoClef):
                return "alto"
            elif isinstance(first_clef, clef.TenorClef):
                return "tenor"
        return "unknown"

    def _analyze_pitch_range(self, flat) -> Optional[Tuple[int, int]]:
        """Analyze the pitch range of a part (returns MIDI note numbers).

        Accepts either a Part or a pre-flattened stream to avoid redundant
        flatten() calls when the caller has already flattened.
        """
        pitches = []

        for element in flat.notesAndRests:
            if isinstance(element, note.Note):
                pitches.append(element.pitch.midi)
            elif isinstance(element, chord.Chord):
                pitches.extend([p.midi for p in element.pitches])

        if not pitches:
            return None

        return (min(pitches), max(pitches))

    def _detect_voice_type(
        self,
        part_name: str,
        clef_type: str,
        pitch_range: Optional[Tuple[int, int]]
    ) -> str:
        """
        Automatically detect voice type based on part name, clef, and pitch range
        """
        part_name_lower = part_name.lower().strip()

        # Check part name for keywords using word-boundary regex.
        # Multi-char keywords use \b to avoid matching inside longer words
        # (e.g. "alt" won't match "alto" — "alto" is its own keyword).
        # Single-letter abbreviations (s, a, t, b) only match at the start
        # of the name followed by '.', a digit, or end-of-string to avoid
        # false positives like "Piano" matching "a" or "Oboe" matching "b".
        soprano_patterns = [r'\bsoprano\b', r'\bsop\b', r'\bsopr\b', r'^s(?=[.\d]|$)']
        alto_patterns = [r'\balto\b', r'\balt\b', r'\bcontr\b', r'\bcounter\b', r'^a(?=[.\d]|$)']
        tenor_patterns = [r'\btenor\b', r'\bten\b', r'^t(?=[.\d]|$)']
        bass_patterns = [r'\bbass\b', r'\bbas\b', r'\bbari\b', r'\bbaritone\b', r'\bbar\b', r'^b(?=[.\d]|$)']

        if any(re.search(p, part_name_lower) for p in soprano_patterns):
            return VoiceType.SOPRANO
        if any(re.search(p, part_name_lower) for p in alto_patterns):
            return VoiceType.ALTO
        if any(re.search(p, part_name_lower) for p in tenor_patterns):
            return VoiceType.TENOR
        if any(re.search(p, part_name_lower) for p in bass_patterns):
            return VoiceType.BASS

        # If no keyword match, use pitch range primarily
        if pitch_range:
            min_pitch, max_pitch = pitch_range

            # Calculate overlap with each voice range
            best_match = VoiceType.OTHER
            best_score = 0

            for voice_type, (voice_min, voice_max) in self.VOICE_RANGES.items():
                # Calculate overlap
                overlap_min = max(min_pitch, voice_min)
                overlap_max = min(max_pitch, voice_max)

                if overlap_max >= overlap_min:
                    overlap_range = overlap_max - overlap_min
                    score = overlap_range / (max_pitch - min_pitch + 1)

                    if score > best_score:
                        best_score = score
                        best_match = voice_type

            # If we have a strong match based on pitch range, return it
            if best_score > self.OVERLAP_THRESHOLD:
                return best_match

            # If we have a moderate match, consider it but factor in clef
            if best_score > self.OVERLAP_THRESHOLD / 2:
                # If clef agrees with pitch range prediction, return it
                if ((best_match == VoiceType.SOPRANO or best_match == VoiceType.ALTO) and clef_type in ["treble", "alto"]) or \
                   ((best_match == VoiceType.TENOR or best_match == VoiceType.BASS) and clef_type in ["bass", "tenor"]):
                    return best_match

        # Fallback to clef-based detection if no strong pitch range match
        if clef_type == "treble":
            return VoiceType.SOPRANO  # Default to soprano for treble clef
        elif clef_type == "bass":
            return VoiceType.BASS  # Default to bass for bass clef
        elif clef_type == "alto":
            return VoiceType.ALTO  # Match clef to voice
        elif clef_type == "tenor":
            return VoiceType.TENOR  # Match clef to voice

        # If no other criteria match, return OTHER
        return VoiceType.OTHER

    def generate_midi_files(
        self,
        musicxml_path: str,
        voice_assignments: Dict[int, str],
        output_dir: str
    ) -> Dict[str, str]:
        """
        Generate separate MIDI files for each voice

        Args:
            musicxml_path: Path to MusicXML file
            voice_assignments: Dict mapping part index to voice type
            output_dir: Directory to save MIDI files

        Returns:
            Dict mapping voice type to MIDI file path
        """
        score = converter.parse(musicxml_path)

        # Group parts by voice type
        voice_parts: Dict[str, List[stream.Part]] = {}
        # Keep OTHER parts aside for potential fallback re-detection
        other_parts: List[Tuple[int, stream.Part]] = []

        for part_idx, part in enumerate(score.parts):
            # Voice assignments come from JS/JSON where keys are always strings ("0", "1", …).
            # Normalize to string so both str and int keys work.
            str_part_idx = str(part_idx)
            voice_type = voice_assignments.get(str_part_idx, voice_assignments.get(part_idx, VoiceType.OTHER))

            if voice_type == VoiceType.OTHER:
                other_parts.append((part_idx, part))
            else:
                if voice_type not in voice_parts:
                    voice_parts[voice_type] = []
                voice_parts[voice_type].append(part)

        # If no SATB voices were explicitly assigned, attempt to detect them from
        # the OTHER parts using pitch/clef analysis so that MIDI generation always
        # produces usable individual voice files.
        satb_voices = {VoiceType.SOPRANO, VoiceType.ALTO, VoiceType.TENOR, VoiceType.BASS}
        if not any(v in voice_parts for v in satb_voices) and other_parts:
            print("No SATB voice assignments found — falling back to automatic detection for MIDI generation.")
            for part_idx, part in other_parts:
                flat = part.flatten()
                clef_type = self._detect_clef(flat)
                pitch_range = self._analyze_pitch_range(flat)
                part_name = part.partName or f"Part {part_idx + 1}"
                detected = self._detect_voice_type(part_name, clef_type, pitch_range)
                if detected != VoiceType.OTHER:
                    if detected not in voice_parts:
                        voice_parts[detected] = []
                    voice_parts[detected].append(part)

        # Generate MIDI file for each voice
        midi_files = {}

        for voice_type, parts in voice_parts.items():
            if voice_type == VoiceType.OTHER:
                continue

            # Create a new score with only this voice's parts
            voice_score = stream.Score()

            for part in parts:
                part_copy = copy.deepcopy(part)
                part_copy.insert(0, self._get_instrument_for_voice(voice_type))
                voice_score.append(part_copy)

            # Write MIDI file
            midi_filename = f"{voice_type}.mid"
            midi_path = os.path.join(output_dir, midi_filename)

            try:
                voice_score.write('midi', fp=midi_path)
            except Exception as e:
                print(f"Warning: Failed to write MIDI for voice '{voice_type}': {e}")
                continue

            midi_files[voice_type] = midi_path

        # Also generate a combined MIDI with all voices
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
from fastapi import FastAPI, File, UploadFile, HTTPException, Form
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


def create_temp_processor():
    """Create a temporary processor instance for a single request"""
    return MusicProcessor()


@app.post("/api/process-pdf")
async def process_pdf(file: UploadFile = File(...)):
    """Process PDF sheet music using OMR"""
    if not file.filename.lower().endswith('.pdf'):
        raise HTTPException(400, "File must be a PDF")

    file_content = await file.read()
    if len(file_content) > 50 * 1024 * 1024:
        raise HTTPException(413, "File too large. Maximum size is 50MB")

    filename = file.filename

    def _run():
        with create_temp_processor() as processor:
            pdf_path = os.path.join(processor.temp_dir, filename)
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
        print(f"Error processing PDF: {str(e)}")
        raise HTTPException(500, "Processing failed. Please try again later.")


@app.post("/api/process-musicxml")
async def process_musicxml(file: UploadFile = File(...)):
    """Process uploaded MusicXML file"""
    if not (file.filename.lower().endswith('.xml') or file.filename.lower().endswith('.musicxml') or file.filename.lower().endswith('.mxl')):
        raise HTTPException(400, "File must be MusicXML (.xml, .musicxml, or .mxl)")

    file_content = await file.read()
    if len(file_content) > 50 * 1024 * 1024:
        raise HTTPException(413, "File too large. Maximum size is 50MB")

    filename = file.filename

    def _run():
        with create_temp_processor() as processor:
            musicxml_path = os.path.join(processor.temp_dir, filename)
            with open(musicxml_path, 'wb') as f:
                f.write(file_content)
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
        print(f"Error processing MusicXML: {str(e)}")
        raise HTTPException(500, "Analysis failed. Please try again later.")


@app.post("/api/generate-midi")
async def generate_midi(
    musicxml: str = Form(...),
    voice_assignments: str = Form(...)
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
        print(f"Error generating MIDI: {str(e)}")
        raise HTTPException(500, "MIDI generation failed. Please try again later.")


@app.get("/health")
async def health_check():
    """Health check endpoint"""
    gemini_configured = bool(os.environ.get("GEMINI_API_KEY"))

    return {
        "status": "healthy",
        "gemini_configured": gemini_configured,
    }


if __name__ == "__main__":
    port = int(os.environ.get("PYTHON_SERVICE_PORT", 8001))
    uvicorn.run(app, host="0.0.0.0", port=port)
