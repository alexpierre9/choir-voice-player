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
try:
    import oemer
    OEMER_AVAILABLE = True
except ImportError:
    OEMER_AVAILABLE = False
    print("Warning: oemer not available. PDF OMR will not work.")

from music21 import converter, stream, note, chord, clef, instrument, midi as m21midi
from pdf2image import convert_from_path
from PIL import Image


class VoiceType:
    SOPRANO = "soprano"
    ALTO = "alto"
    TENOR = "tenor"
    BASS = "bass"
    OTHER = "other"


class MusicProcessor:
    """Main processor for sheet music analysis and MIDI generation"""
    
    # Pitch ranges for SATB voices (MIDI note numbers)
    VOICE_RANGES = {
        VoiceType.SOPRANO: (60, 81),  # C4 to A5
        VoiceType.ALTO: (55, 76),     # G3 to E5
        VoiceType.TENOR: (48, 69),    # C3 to A4
        VoiceType.BASS: (40, 64),     # E2 to E4
    }
    
    def __init__(self):
        self.temp_dir = tempfile.mkdtemp()
    
    def process_pdf(self, pdf_path: str) -> str:
        """
        Convert PDF to MusicXML using OMR
        Returns path to generated MusicXML file
        """
        if not OEMER_AVAILABLE:
            raise RuntimeError("OMR (oemer) is not available. Please install it.")
        
        # Convert first page of PDF to image
        images = convert_from_path(pdf_path, first_page=1, last_page=1, dpi=300)
        
        if not images:
            raise ValueError("Could not extract images from PDF")
        
        # Save image temporarily
        img_path = os.path.join(self.temp_dir, "sheet_music.png")
        images[0].save(img_path, "PNG")
        
        # Run OMR
        output_dir = self.temp_dir
        print(f"Running OMR on {img_path}...")
        
        # oemer command line: oemer <image_path> -o <output_path>
        import subprocess
        result = subprocess.run(
            ["oemer", img_path, "-o", output_dir, "--without-deskew"],
            capture_output=True,
            text=True,
            timeout=300  # 5 minutes timeout
        )
        
        if result.returncode != 0:
            print(f"OMR stderr: {result.stderr}")
            raise RuntimeError(f"OMR processing failed: {result.stderr}")
        
        # Find generated MusicXML file
        musicxml_files = list(Path(output_dir).glob("*.musicxml"))
        if not musicxml_files:
            musicxml_files = list(Path(output_dir).glob("*.xml"))
        
        if not musicxml_files:
            raise RuntimeError("OMR did not produce a MusicXML file")
        
        return str(musicxml_files[0])
    
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
        part_name_lower = part_name.lower()
        
        # Check part name for keywords
        if any(keyword in part_name_lower for keyword in ["soprano", "sop", "s "]):
            return VoiceType.SOPRANO
        if any(keyword in part_name_lower for keyword in ["alto", "alt", "a "]):
            return VoiceType.ALTO
        if any(keyword in part_name_lower for keyword in ["tenor", "ten", "t "]):
            return VoiceType.TENOR
        if any(keyword in part_name_lower for keyword in ["bass", "bas", "b "]):
            return VoiceType.BASS
        
        # If no keyword match, use clef and pitch range
        if pitch_range:
            min_pitch, max_pitch = pitch_range
            avg_pitch = (min_pitch + max_pitch) / 2
            
            # Calculate overlap with each voice range
            best_match = VoiceType.OTHER
            best_score = 0
            
            for voice_type, (voice_min, voice_max) in self.VOICE_RANGES.items():
                # Calculate overlap
                overlap_min = max(min_pitch, voice_min)
                overlap_max = min(max_pitch, voice_max)
                
                if overlap_max >= overlap_min:
                    overlap = overlap_max - overlap_min
                    score = overlap / (max_pitch - min_pitch + 1)
                    
                    if score > best_score:
                        best_score = score
                        best_match = voice_type
            
            if best_score > 0.3:  # At least 30% overlap
                return best_match
        
        # Fallback to clef-based detection
        if clef_type == "treble":
            return VoiceType.SOPRANO
        elif clef_type == "bass":
            return VoiceType.BASS
        
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
            voice_type = voice_assignments.get(part_idx, VoiceType.OTHER)
            
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
    
    def cleanup(self):
        """Clean up temporary files"""
        import shutil
        if os.path.exists(self.temp_dir):
            shutil.rmtree(self.temp_dir)


# FastAPI endpoints
from fastapi import FastAPI, File, UploadFile, HTTPException, Form
from fastapi.responses import JSONResponse, FileResponse
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

app = FastAPI(title="Choir Voice Player - Music Processing Service")

# Enable CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global processor instance
processor = MusicProcessor()


@app.post("/api/process-pdf")
async def process_pdf(file: UploadFile = File(...)):
    """Process PDF sheet music using OMR"""
    if not file.filename.endswith('.pdf'):
        raise HTTPException(400, "File must be a PDF")
    
    # Save uploaded file
    pdf_path = os.path.join(processor.temp_dir, file.filename)
    with open(pdf_path, 'wb') as f:
        content = await file.read()
        f.write(content)
    
    try:
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
    
    except Exception as e:
        raise HTTPException(500, f"Processing failed: {str(e)}")


@app.post("/api/process-musicxml")
async def process_musicxml(file: UploadFile = File(...)):
    """Process uploaded MusicXML file"""
    if not (file.filename.endswith('.xml') or file.filename.endswith('.musicxml') or file.filename.endswith('.mxl')):
        raise HTTPException(400, "File must be MusicXML (.xml, .musicxml, or .mxl)")
    
    # Save uploaded file
    musicxml_path = os.path.join(processor.temp_dir, file.filename)
    with open(musicxml_path, 'wb') as f:
        content = await file.read()
        f.write(content)
    
    try:
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
    
    except Exception as e:
        raise HTTPException(500, f"Analysis failed: {str(e)}")


@app.post("/api/generate-midi")
async def generate_midi(
    musicxml: str = Form(...),
    voice_assignments: str = Form(...)
):
    """Generate MIDI files for each voice"""
    
    # Parse voice assignments
    try:
        assignments = json.loads(voice_assignments)
    except json.JSONDecodeError:
        raise HTTPException(400, "Invalid voice_assignments JSON")
    
    # Save MusicXML to temp file
    musicxml_path = os.path.join(processor.temp_dir, "score.musicxml")
    with open(musicxml_path, 'w') as f:
        f.write(musicxml)
    
    # Create output directory
    output_dir = os.path.join(processor.temp_dir, "midi_output")
    os.makedirs(output_dir, exist_ok=True)
    
    try:
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
    
    except Exception as e:
        raise HTTPException(500, f"MIDI generation failed: {str(e)}")


@app.get("/health")
async def health_check():
    """Health check endpoint"""
    return {
        "status": "healthy",
        "oemer_available": OEMER_AVAILABLE,
    }


if __name__ == "__main__":
    port = int(os.environ.get("PYTHON_SERVICE_PORT", 8001))
    uvicorn.run(app, host="0.0.0.0", port=port)

