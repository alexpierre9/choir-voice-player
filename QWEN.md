# Choir Voice Player - Development Context

## Project Overview

Choir Voice Player is a full-stack web application designed for choir directors and singers that analyzes sheet music and plays individual SATB voice parts. The application supports both PDF (using Optical Music Recognition) and MusicXML file formats for sheet music input.

### Key Technologies
- **Frontend**: React 19, TypeScript, Tailwind CSS, shadcn/ui
- **Backend**: Node.js/Express with tRPC, Python/FastAPI for music processing
- **Database**: MySQL (with TiDB compatibility) using Drizzle ORM
- **Audio**: Tone.js for MIDI playback, @tonejs/midi for parsing
- **File Storage**: S3-compatible storage for sheet music and processed files
- **Authentication**: Manus OAuth system

### Architecture
The application follows a microservice architecture with:
1. **Node.js API Server** (port 3000): Main application server handling authentication, user management, and tRPC API
2. **Python Music Processing Service** (port 8001): Handles OMR (Optical Music Recognition), MusicXML parsing, voice detection, and MIDI generation
3. **Database Layer**: MySQL with Drizzle ORM for data persistence
4. **Storage Layer**: S3-compatible object storage for files

## Building and Running

### Prerequisites
- Node.js 22+
- Python 3.11+
- MySQL/TiDB database
- S3-compatible storage
- Google Gemini API key (for PDF OMR)

### Installation Steps

1. **Install Node dependencies**:
```bash
pnpm install
```

2. **Install Python dependencies**:
```bash
pip3 install oemer music21 pdf2image pillow fastapi uvicorn python-multipart google-generativeai
```

3. **Set up environment variables** (copy from `.env.example`):
```
DATABASE_URL=mysql://user:password@host:port/database
JWT_SECRET=your-secret-key
VITE_APP_ID=oauth-app-id
OAUTH_SERVER_URL=https://oauth-server-url
VITE_OAUTH_PORTAL_URL=https://oauth-portal-url
BUILT_IN_FORGE_API_URL=https://api-url
BUILT_IN_FORGE_API_KEY=api-key
GEMINI_API_KEY=your-gemini-api-key
PYTHON_SERVICE_PORT=8001
```

4. **Push database schema**:
```bash
pnpm db:push
```

5. **Start Python music processing service**:
```bash
PYTHON_SERVICE_PORT=8001 python3 python_service/music_processor.py
```

6. **Start development server**:
```bash
pnpm dev
```

### Development Scripts
- `pnpm dev`: Start development server with hot reloading
- `pnpm build`: Build production version
- `pnpm start`: Start production server (requires build first)
- `pnpm check`: Type check TypeScript files
- `pnpm format`: Format code with Prettier
- `pnpm test`: Run tests with Vitest
- `pnpm db:push`: Push database schema changes

## Development Conventions

### Frontend Structure
- **Client code**: Located in `client/src/`
- **Components**: Reusable UI components in `client/src/components/`
- **Pages**: Application pages in `client/src/pages/`
- **Hooks**: Custom React hooks in `client/src/hooks/`
- **Lib**: Shared utilities in `client/src/lib/`
- **Contexts**: React contexts in `client/src/contexts/`

### Backend Structure
- **API Routes**: Defined using tRPC in `server/routers.ts`
- **Database Operations**: In `server/db.ts`
- **Storage Operations**: In `server/storage.ts`
- **Core Server Logic**: In `server/_core/`
- **Python Service**: In `python_service/music_processor.py`

### Database Schema
The application uses two main tables:
1. **users**: Stores user authentication and profile information
2. **sheet_music**: Stores sheet music metadata, processing status, analysis results, and file references

### Voice Detection Algorithm
The system uses a multi-factor approach to detect SATB voices:
1. **Part Name Analysis**: Checks for keywords like "Soprano", "Alto", "Tenor", "Bass"
2. **Clef Detection**: Treble clef suggests upper voices, bass clef suggests lower voices
3. **Pitch Range Analysis**: Compares note ranges against typical SATB ranges:
   - Soprano: C4-A5 (MIDI 60-81)
   - Alto: G3-E5 (MIDI 55-76)
   - Tenor: C3-A4 (MIDI 48-69)
   - Bass: E2-E4 (MIDI 40-64)

### File Processing Flow
1. **Upload**: File uploaded via tRPC mutation
2. **Storage**: Original file stored in S3-compatible storage
3. **Processing**:
   - PDF → OMR (using Google Gemini Vision) → MusicXML
   - MusicXML → Analysis (using music21) → Voice detection
4. **MIDI Generation**: Separate MIDI files created for each voice
5. **Playback**: MIDI files loaded in browser via Tone.js

### API Endpoints
- **tRPC Procedures** (under `/api/trpc`):
  - `sheetMusic.upload`: Upload and process sheet music
  - `sheetMusic.get`: Get sheet music details
  - `sheetMusic.list`: List user's sheet music
  - `sheetMusic.updateVoiceAssignments`: Update voice assignments
  - `sheetMusic.getMidiUrl`: Get presigned URL for MIDI file
  - `sheetMusic.delete`: Delete sheet music

- **Python Service Endpoints** (on port 8001):
  - `POST /api/process-pdf`: Process PDF with OMR
  - `POST /api/process-musicxml`: Analyze MusicXML
  - `POST /api/generate-midi`: Generate MIDI files
  - `GET /health`: Health check

### Authentication
The application uses Manus OAuth for authentication. Protected routes use middleware that checks for valid session cookies. Unauthorized requests redirect to the login page.

### Testing
- Unit tests: Using Vitest
- API tests: Through tRPC procedures
- Integration tests: Not specified in current codebase

### Code Style
- TypeScript: Strict mode enabled
- React: Functional components with hooks
- Styling: Tailwind CSS with shadcn/ui components
- Formatting: Prettier with project-specific configuration
- Naming: PascalCase for components, camelCase for functions and variables