"""
Music Processing Service for Choir Voice Player
Handles OMR, MusicXML parsing, voice detection, and MIDI generation
"""

import os
import tempfile
import json
from typing import Dict, List, Optional, Tuple
from pathlib import Path
import base64

# OMR and Music Processing
import google.generativeai as genai
from music21 import converter, stream, note, chord, clef, instrument, midi as m21midi
from pdf2image import convert_from_path
from PIL import Image
from dotenv import load_dotenv

load_dotenv()

# Configure Gemini
GENAI_API_KEY = os.environ.get("GEMINI_API_KEY")
if GENAI_API_KEY:
    genai.configure(api_key=GENAI_API_KEY)
else:
    print("Warning: GEMINI_API_KEY not found. PDF OMR will not work.")

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
        import shutil
        if os.path.exists(self.temp_dir):
            shutil.rmtree(self.temp_dir, ignore_errors=True)
    
    def __del__(self):
        """Destructor to ensure cleanup"""
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
        
        if not os.environ.get("GEMINI_API_KEY"):
            raise RuntimeError("GEMINI_API_KEY is not set")
        
        # Convert first page of PDF to image
        images = convert_from_path(pdf_path, dpi=300)
        
        if not images:
            raise ValueError("Could not extract images from PDF")
        
        print(f"Running Gemini Vision OMR on {pdf_path} ({len(images)} page(s))...")
        
        try:
            model_name = os.environ.get("GEMINI_MODEL_NAME", "gemini-1.5-pro")
            model = genai.GenerativeModel(model_name)
            
            prompt = f"""
            Transcribe this sheet music into valid MusicXML format.
            This score spans {len(images)} page(s) — all pages are provided in order.
            Capture ALL parts, voices, notes, rhythms, and key signatures across every page.
            Return ONLY the raw MusicXML code for the complete score.
            Do not include any markdown formatting (like ```xml).
            Start with <?xml and end with </score-partwise>.
            """
            
            # Send all pages to Gemini in one request
            response = model.generate_content([prompt, *images])
            content = response.text
            
            # Clean up potential markdown formatting
            if "```xml" in content:
                content = content.split("```xml")[1].split("```")[0].strip()
            elif "```" in content:
                 content = content.split("```")[1].strip()
            
            # Validate MusicXML structure
            if not content.startswith("<?xml") and not content.startswith("<score-partwise"):
                 start_idx = content.find("<?xml")
                 if start_idx == -1:
                     start_idx = content.find("<score-partwise")
                 
                 if start_idx != -1:
                     content = content[start_idx:]
                 else:
                     raise ValueError("Gemini did not return valid XML start tag")

            output_path = os.path.join(self.temp_dir, "score.musicxml")
            with open(output_path, "w") as f:
                f.write(content)
            
            # Validate with music21
            try:
                converter.parse(output_path)
            except Exception as e:
                # If music21 fails, we might still want to return the file for manual fixing,
                # but for now let's raise
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
            
            # Detect clef
            clef_type = self._detect_clef(part)
            
            # Analyze pitch range
            pitch_range = self._analyze_pitch_range(part)
            
            # Detect voice type automatically
            detected_voice = self._detect_voice_type(part_name, clef_type, pitch_range)
            
            # Count notes
            note_count = len(part.flatten().notes)
            
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
    
    def _detect_clef(self, part: stream.Part) -> str:
        """Detect the primary clef used in a part"""
        clefs = part.flatten().getElementsByClass(clef.Clef)
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
    
    def _analyze_pitch_range(self, part: stream.Part) -> Optional[Tuple[int, int]]:
        """Analyze the pitch range of a part (returns MIDI note numbers)"""
        pitches = []
        
        for element in part.flatten().notesAndRests:
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

        # Check part name for keywords (with more comprehensive matching)
        soprano_keywords = ["soprano", "sop", "s ", "s.", "sopr"]
        alto_keywords = ["alto", "alt", "a ", "a.", "contr", "counter"]
        tenor_keywords = ["tenor", "ten", "t ", "t.", "ten."]
        bass_keywords = ["bass", "bas", "b ", "b.", "bass.", "bari", "baritone", "bar"]

        if any(keyword in part_name_lower for keyword in soprano_keywords):
            return VoiceType.SOPRANO
        if any(keyword in part_name_lower for keyword in alto_keywords):
            return VoiceType.ALTO
        if any(keyword in part_name_lower for keyword in tenor_keywords):
            return VoiceType.TENOR
        if any(keyword in part_name_lower for keyword in bass_keywords):
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
        
        for part_idx, part in enumerate(score.parts):
            # Voice assignments come from JS/JSON where keys are always strings ("0", "1", …).
            # Normalize to string so both str and int keys work.
            str_part_idx = str(part_idx)
            voice_type = voice_assignments.get(str_part_idx, voice_assignments.get(part_idx, VoiceType.OTHER))
            
            if voice_type not in voice_parts:
                voice_parts[voice_type] = []
            
            voice_parts[voice_type].append(part)
        
        # Generate MIDI file for each voice
        midi_files = {}
        
        for voice_type, parts in voice_parts.items():
            if voice_type == VoiceType.OTHER:
                continue
            
            # Create a new score with only this voice's parts
            voice_score = stream.Score()
            
            for part in parts:
                # Set appropriate instrument
                inst = self._get_instrument_for_voice(voice_type)
                part.insert(0, inst)
                voice_score.append(part)
            
            # Write MIDI file
            midi_filename = f"{voice_type}.mid"
            midi_path = os.path.join(output_dir, midi_filename)
            
            voice_score.write('midi', fp=midi_path)
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
from fastapi.responses import JSONResponse, FileResponse
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
    # Validate file type
    if not file.filename.lower().endswith('.pdf'):
        raise HTTPException(400, "File must be a PDF")

    # Validate file size (50MB limit)
    file_content = await file.read()
    if len(file_content) > 50 * 1024 * 1024:  # 50MB
        raise HTTPException(413, "File too large. Maximum size is 50MB")

    processor = create_temp_processor()
    try:
        # Save uploaded file
        pdf_path = os.path.join(processor.temp_dir, file.filename)
        with open(pdf_path, 'wb') as f:
            f.write(file_content)

        # Convert PDF to MusicXML
        musicxml_path = processor.process_pdf(pdf_path)

        # Analyze the MusicXML
        analysis = processor.analyze_musicxml(musicxml_path)

        # Read MusicXML content
        with open(musicxml_path, 'r') as f:
            musicxml_content = f.read()

        return JSONResponse({
            "success": True,
            "musicxml": musicxml_content,
            "analysis": analysis,
        })

    except HTTPException:
        # Re-raise HTTP exceptions as-is
        raise
    except Exception as e:
        # Log the full error for debugging but return a sanitized message to the client
        print(f"Error processing PDF: {str(e)}")
        raise HTTPException(500, "Processing failed. Please try again later.")
    finally:
        # Clean up the temporary processor
        processor.cleanup()


@app.post("/api/process-musicxml")
async def process_musicxml(file: UploadFile = File(...)):
    """Process uploaded MusicXML file"""
    # Validate file type
    if not (file.filename.lower().endswith('.xml') or file.filename.lower().endswith('.musicxml') or file.filename.lower().endswith('.mxl')):
        raise HTTPException(400, "File must be MusicXML (.xml, .musicxml, or .mxl)")

    # Validate file size (50MB limit)
    file_content = await file.read()
    if len(file_content) > 50 * 1024 * 1024:  # 50MB
        raise HTTPException(413, "File too large. Maximum size is 50MB")

    processor = create_temp_processor()
    try:
        # Save uploaded file
        musicxml_path = os.path.join(processor.temp_dir, file.filename)
        with open(musicxml_path, 'wb') as f:
            f.write(file_content)

        # Analyze the MusicXML
        analysis = processor.analyze_musicxml(musicxml_path)

        # Read MusicXML content
        with open(musicxml_path, 'r') as f:
            musicxml_content = f.read()

        return JSONResponse({
            "success": True,
            "musicxml": musicxml_content,
            "analysis": analysis,
        })

    except HTTPException:
        # Re-raise HTTP exceptions as-is
        raise
    except Exception as e:
        # Log the full error for debugging but return a sanitized message to the client
        print(f"Error processing MusicXML: {str(e)}")
        raise HTTPException(500, "Analysis failed. Please try again later.")
    finally:
        # Clean up the temporary processor
        processor.cleanup()


@app.post("/api/generate-midi")
async def generate_midi(
    musicxml: str = Form(...),
    voice_assignments: str = Form(...)
):
    """Generate MIDI files for each voice"""

    # Validate MusicXML content length
    if len(musicxml) > 50 * 1024 * 1024:  # 50MB
        raise HTTPException(413, "MusicXML content too large. Maximum size is 50MB")

    # Parse voice assignments
    try:
        assignments = json.loads(voice_assignments)
    except json.JSONDecodeError:
        raise HTTPException(400, "Invalid voice_assignments JSON")

    processor = create_temp_processor()
    try:
        # Save MusicXML to temp file
        musicxml_path = os.path.join(processor.temp_dir, "score.musicxml")
        with open(musicxml_path, 'w') as f:
            f.write(musicxml)

        # Create output directory
        output_dir = os.path.join(processor.temp_dir, "midi_output")
        os.makedirs(output_dir, exist_ok=True)

        # Generate MIDI files
        midi_files = processor.generate_midi_files(
            musicxml_path,
            assignments,
            output_dir
        )

        # Read MIDI files and encode as base64
        midi_data = {}
        for voice_type, midi_path in midi_files.items():
            with open(midi_path, 'rb') as f:
                midi_content = f.read()
                midi_data[voice_type] = base64.b64encode(midi_content).decode('utf-8')

        return JSONResponse({
            "success": True,
            "midi_files": midi_data,
        })

    except HTTPException:
        # Re-raise HTTP exceptions as-is
        raise
    except Exception as e:
        # Log the full error for debugging but return a sanitized message to the client
        print(f"Error generating MIDI: {str(e)}")
        raise HTTPException(500, "MIDI generation failed. Please try again later.")
    finally:
        # Clean up the temporary processor
        processor.cleanup()


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

