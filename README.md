# Choir Voice Player

A full-stack web application for choir directors and singers that analyzes sheet music and plays individual SATB voice parts.

## Features

### 🎵 Dual Input Support
- **PDF Upload**: Uses Optical Music Recognition (OMR) with oemer library to extract music from scanned PDFs
- **MusicXML Upload**: Direct support for digital MusicXML files (.xml, .musicxml, .mxl)

### 🎯 Automatic Voice Detection
- Automatically identifies Soprano, Alto, Tenor, and Bass parts
- Detection based on:
  - Part names in the score
  - Clef types (treble, bass)
  - Pitch ranges (MIDI note analysis)
- Manual override options for each part

### 🎹 MIDI Playback
- Individual voice playback controls
- Mute/unmute each voice
- Volume control per voice
- Play/pause/stop controls
- Progress bar with time display
- Built with Tone.js for high-quality browser-based synthesis

## Architecture

### Backend (Node.js + Python)
- **Node.js/Express**: Main API server with tRPC endpoints
- **Python Service**: Music processing service (port 8001)
  - **oemer**: Optical Music Recognition for PDF processing
  - **music21**: MusicXML parsing and MIDI generation
  - **FastAPI**: REST API for music processing

### Frontend (React + TypeScript)
- **React 19**: Modern UI components
- **Tone.js**: Web Audio MIDI playback
- **@tonejs/midi**: MIDI file parsing
- **shadcn/ui**: UI component library
- **Tailwind CSS**: Styling

### Database (MySQL/TiDB)
- User authentication via Manus OAuth
- Sheet music metadata storage
- Voice assignments tracking
- S3 integration for file storage

## Getting Started

### Prerequisites
- Node.js 22+
- Python 3.11+
- MySQL/TiDB database
- S3-compatible storage

### Installation

1. **Install Node dependencies**:
```bash
pnpm install
```

2. **Install Python dependencies**:
```bash
pip3 install oemer music21 pdf2image pillow fastapi uvicorn python-multipart
```

3. **Set up environment variables** (automatically injected in Manus platform):
- `DATABASE_URL`: MySQL connection string
- `JWT_SECRET`: Session signing secret
- `VITE_APP_ID`: OAuth application ID
- `OAUTH_SERVER_URL`: OAuth backend URL
- `VITE_OAUTH_PORTAL_URL`: OAuth login portal URL
- `BUILT_IN_FORGE_API_URL`: Manus APIs endpoint
- `BUILT_IN_FORGE_API_KEY`: API authentication key

4. **Push database schema**:
```bash
pnpm db:push
```

5. **Start Python music processing service**:
```bash
PYTHON_SERVICE_PORT=8001 python3 python_service/music_processor.py &
```

6. **Start development server**:
```bash
pnpm dev
```

## Usage

1. **Upload Sheet Music**
   - Click "Upload Sheet Music" button
   - Select a PDF or MusicXML file
   - Optionally provide a title
   - Click "Upload and Process"

2. **Review Voice Assignments**
   - System automatically detects SATB voices
   - Review the detected assignments
   - Use dropdown menus to manually adjust if needed
   - Click "Save Changes" to regenerate MIDI files

3. **Play Individual Voices**
   - Use the MIDI player to control playback
   - Mute/unmute individual voices
   - Adjust volume for each voice
   - Follow along with the progress bar

## Voice Detection Algorithm

The system uses a multi-factor approach to detect voices:

1. **Part Name Analysis**: Checks for keywords like "Soprano", "Alto", "Tenor", "Bass"
2. **Clef Detection**: Treble clef suggests upper voices, bass clef suggests lower voices
3. **Pitch Range Analysis**: Compares note ranges against typical SATB ranges:
   - Soprano: C4-A5 (MIDI 60-81)
   - Alto: G3-E5 (MIDI 55-76)
   - Tenor: C3-A4 (MIDI 48-69)
   - Bass: E2-E4 (MIDI 40-64)

## Technical Details

### File Processing Flow

1. **Upload**: File uploaded via tRPC mutation
2. **Storage**: Original file stored in S3
3. **Processing**: 
   - PDF → OMR (oemer) → MusicXML
   - MusicXML → Analysis (music21) → Voice detection
4. **MIDI Generation**: Separate MIDI files created for each voice
5. **Playback**: MIDI files loaded in browser via Tone.js

### Database Schema

**users**: User authentication and profiles
**sheet_music**: 
- Metadata (title, filename, file type)
- Processing status (uploading, processing, ready, error)
- Analysis results (parts, voice assignments)
- S3 keys for original files, MusicXML, and MIDI files

## API Endpoints

### tRPC Procedures

- `sheetMusic.upload`: Upload and process sheet music
- `sheetMusic.get`: Get sheet music details
- `sheetMusic.list`: List user's sheet music
- `sheetMusic.updateVoiceAssignments`: Update voice assignments
- `sheetMusic.getMidiUrl`: Get presigned URL for MIDI file
- `sheetMusic.delete`: Delete sheet music

### Python Service (FastAPI)

- `POST /api/process-pdf`: Process PDF with OMR
- `POST /api/process-musicxml`: Analyze MusicXML
- `POST /api/generate-midi`: Generate MIDI files
- `GET /health`: Health check

## Limitations

- **OMR Accuracy**: PDF recognition quality depends on scan quality and notation complexity
- **Western Notation Only**: Trained on Western music notation
- **Processing Time**: PDF processing can take 3-5 minutes depending on complexity
- **GPU Recommended**: OMR performs better with GPU acceleration

## Future Enhancements

- Sheet music visualization during playback
- More voice types (SSA, TTBB, etc.)
- Tempo and dynamics control
- Export to other formats
- Collaborative features
- Mobile app

## License

Built for choir directors and singers.

## Credits

- **OMR**: [oemer](https://github.com/BreezeWhite/oemer) by BreezeWhite
- **Music Analysis**: [music21](https://web.mit.edu/music21/) by MIT
- **MIDI Playback**: [Tone.js](https://tonejs.github.io/)
- **UI Components**: [shadcn/ui](https://ui.shadcn.com/)

