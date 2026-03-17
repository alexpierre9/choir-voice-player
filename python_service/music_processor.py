"""
Music Processing Service for Choir Voice Player
Handles OMR, MusicXML parsing, voice detection, and MIDI generation
"""

import logging
import os
import re
import shutil
import subprocess
import tempfile
import json
import xml.etree.ElementTree as ET
import zipfile
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

# Mutable Gemini configuration — can be updated at runtime via /api/update-config.
_config: Dict = {
    "gemini_api_key": os.environ.get("GEMINI_API_KEY", ""),
    "gemini_model_name": os.environ.get("GEMINI_MODEL_NAME", "gemini-2.0-flash"),
    "gemini_max_output_tokens": int(os.environ.get("GEMINI_MAX_OUTPUT_TOKENS", "8192")),
    "gemini_timeout_s": int(os.environ.get("GEMINI_TIMEOUT", "120")),
    "deep_correction_enabled": os.environ.get("DEEP_CORRECTION_ENABLED", "true").lower() == "true",
    "deep_correction_batch_size": int(os.environ.get("DEEP_CORRECTION_BATCH_SIZE", "4")),
}

# Timeout for Gemini API calls, in seconds (env var uses human-readable seconds;
# the google-genai SDK HttpOptions.timeout field is in *milliseconds*).
GENAI_CLIENT: "genai.Client | None" = None


def _rebuild_genai_client() -> None:
    """(Re)build the Gemini client from the current _config dict."""
    global GENAI_CLIENT
    api_key = _config.get("gemini_api_key", "")
    if api_key:
        timeout_s = _config.get("gemini_timeout_s", 120)
        GENAI_CLIENT = genai.Client(
            api_key=api_key,
            http_options={"timeout": timeout_s * 1000},
        )
    else:
        GENAI_CLIENT = None
        logger.warning("GEMINI_API_KEY not found. PDF OMR will not work.")


# Build initial client from environment
_rebuild_genai_client()


def _classify_error(exc: Exception) -> Tuple[str, str]:
    """Map an exception to (category, safe_message) for structured error responses.

    Strips file paths and internal details from the message while preserving
    enough information for the user to understand what went wrong.
    """
    msg = str(exc)

    # API key / auth issues
    if any(kw in msg.lower() for kw in ["api key", "api_key", "invalid key", "api_key_invalid",
                                         "permission denied", "403", "401", "unauthorized",
                                         "authentication"]):
        return ("api_key", "Gemini API key is invalid or expired. Check your API key in Settings.")

    # Quota / rate limit
    if any(kw in msg.lower() for kw in ["quota", "rate limit", "resource exhausted", "429",
                                         "too many requests"]):
        return ("quota", "Gemini API quota exceeded. Please wait a few minutes and try again.")

    # Model not found
    if any(kw in msg.lower() for kw in ["model not found", "not found", "404"]) and "model" in msg.lower():
        return ("model", f"Gemini model not found. Check the model name in Settings.")

    # Output truncation
    if "max_tokens" in msg.lower() or "truncated" in msg.lower():
        return ("truncation", "The score is too large for the model's output limit. Try fewer pages.")

    # MusicXML parse failures
    if any(kw in msg.lower() for kw in ["musicxml is invalid", "invalid xml", "parse error",
                                         "xml syntax"]):
        return ("parse", "The generated MusicXML could not be parsed. The score may be too complex for AI transcription.")

    # Gemini didn't return valid XML
    if "did not return valid xml" in msg.lower():
        return ("parse", "Gemini did not return valid sheet music data. Try uploading a clearer scan.")

    # Network / timeout
    if any(kw in msg.lower() for kw in ["timeout", "timed out", "deadline exceeded",
                                         "connection error", "connection refused"]):
        return ("network", "Request timed out. The service may be overloaded — try again shortly.")

    # GEMINI_API_KEY not set
    if "gemini_api_key is not set" in msg.lower():
        return ("api_key", "Gemini API key is not configured. Add it in Settings.")

    # Strip file paths from unknown errors for safety
    safe_msg = re.sub(r'[A-Za-z]:\\[^\s:]+|/[^\s:]+/', '', msg).strip()
    if not safe_msg:
        safe_msg = "An unexpected error occurred."

    return ("unknown", safe_msg)

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

    def _run_audiveris(self, pdf_path: str) -> str:
        """Run Audiveris CLI to convert PDF to MusicXML. Returns path to output MusicXML."""
        audiveris_cmd = os.environ.get("AUDIVERIS_CMD", "audiveris")
        output_dir = os.path.join(self.temp_dir, "audiveris_output")
        os.makedirs(output_dir, exist_ok=True)

        cmd = [audiveris_cmd, "-batch", "-export", "-output", output_dir, pdf_path]
        logger.info("Running Audiveris: %s", " ".join(cmd))

        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        except FileNotFoundError:
            raise RuntimeError(
                "Audiveris is not installed. Install it via deploy/setup.sh "
                "or set AUDIVERIS_CMD to the correct path."
            )
        except subprocess.TimeoutExpired:
            raise RuntimeError("Audiveris timed out after 120 seconds")

        if result.returncode != 0:
            logger.error("Audiveris stderr: %s", result.stderr)
            raise RuntimeError(f"Audiveris failed (exit {result.returncode}): {result.stderr[:500]}")

        # Audiveris outputs .mxl (compressed MusicXML) files
        mxl_files = [f for f in os.listdir(output_dir) if f.endswith(".mxl")]
        if not mxl_files:
            xml_files = [f for f in os.listdir(output_dir) if f.endswith(".xml")]
            if xml_files:
                return os.path.join(output_dir, xml_files[0])
            raise RuntimeError("Audiveris produced no output files")

        # Extract .mxl (ZIP containing MusicXML)
        mxl_path = os.path.join(output_dir, mxl_files[0])
        with zipfile.ZipFile(mxl_path, "r") as zf:
            xml_names = [n for n in zf.namelist() if n.endswith(".xml") and not n.startswith("META-INF")]
            if not xml_names:
                raise RuntimeError("Audiveris .mxl contains no XML files")
            extracted_path = os.path.join(output_dir, "score.xml")
            with open(extracted_path, "wb") as out:
                out.write(zf.read(xml_names[0]))

        return extracted_path

    def _refine_musicxml(self, musicxml_path: str, pdf_path: str) -> str:
        """Use Gemini AI to apply targeted patch corrections to Audiveris MusicXML output.

        Instead of asking Gemini to regenerate the entire MusicXML (which exceeds ~8K output
        token limits for scores larger than ~35KB), we ask it to return a compact JSON list of
        corrections and apply them programmatically.  This keeps Gemini's output well under the
        token cap while still fixing the most important issues (part names, clef errors, etc.).
        """
        if GENAI_CLIENT is None:
            return musicxml_path

        with open(musicxml_path, "r", encoding="utf-8") as f:
            musicxml_text = f.read()

        part_summary = self._extract_part_summary(musicxml_text)

        prompt = (
            "You are a music engraving expert reviewing MusicXML output from Audiveris"
            " (optical music recognition).\n\n"
            "Analyze the MusicXML snippet and part list below, then return a JSON array of"
            " corrections to apply. Each correction is an object with:\n"
            '- "type": one of "rename_part", "fix_clef", "fix_transposition",'
            ' "add_dynamic", "fix_time_signature"\n'
            '- "part_id": the part ID from the XML (e.g. "P1", "P2")\n'
            '- "current_value": what Audiveris produced\n'
            '- "correct_value": what it should be\n\n'
            "Focus ONLY on:\n"
            "1. Part names — rename generic names like \"Part_1\" to proper voice names"
            " (Soprano, Alto, Tenor, Bass) based on pitch ranges and clef.\n"
            "2. Obvious clef errors — e.g. a soprano part using bass clef.\n"
            "3. Time signature errors — only if clearly wrong.\n\n"
            "Do NOT attempt to correct individual notes, rhythms, lyrics, or measures.\n"
            "Return ONLY a valid JSON array, no explanation, no markdown.\n\n"
            "Example output:\n"
            '[\n'
            '  {"type": "rename_part", "part_id": "P1", "current_value": "Part_1", "correct_value": "Soprano"},\n'
            '  {"type": "rename_part", "part_id": "P2", "current_value": "Part_2", "correct_value": "Alto"}\n'
            ']\n\n'
            f"MusicXML to analyze (first 8000 chars):\n{musicxml_text[:8000]}\n\n"
            f"Full part list from XML:\n{part_summary}"
        )

        model_name = _config.get("gemini_model_name", "gemini-2.0-flash")
        max_tokens = int(_config.get("gemini_max_output_tokens", 8192))

        try:
            response = GENAI_CLIENT.models.generate_content(
                model=model_name,
                contents=[prompt],
                config=genai_types.GenerateContentConfig(
                    max_output_tokens=max_tokens,
                    temperature=0.1,
                ),
            )

            corrections_text = response.text.strip()
            logger.info("Gemini refinement raw response: %s", corrections_text[:500])

            # Strip markdown fences if Gemini wrapped the JSON
            if corrections_text.startswith("```"):
                lines = corrections_text.split("\n")
                lines = lines[1:]
                if lines and lines[-1].strip() == "```":
                    lines = lines[:-1]
                corrections_text = "\n".join(lines)

            corrections = json.loads(corrections_text)
            if not isinstance(corrections, list):
                raise ValueError(f"Expected JSON array, got {type(corrections)}")

            logger.info("Gemini returned %d correction(s): %s", len(corrections), corrections)
            refined_xml = self._apply_corrections(musicxml_text, corrections)

            # Validate the patched XML before writing
            try:
                ET.fromstring(refined_xml)
            except ET.ParseError as parse_err:
                logger.warning(
                    "Patched XML is invalid (%s), using raw Audiveris output", parse_err
                )
                return musicxml_path

            refined_path = os.path.join(self.temp_dir, "refined_score.xml")
            with open(refined_path, "w", encoding="utf-8") as f:
                f.write(refined_xml)

            logger.info("AI refinement applied %d correction(s), saved to %s", len(corrections), refined_path)
            return refined_path

        except Exception as e:
            logger.warning("Gemini refinement failed (%s), using raw Audiveris output", e)
            return musicxml_path

    def _extract_part_summary(self, musicxml: str) -> str:
        """Extract part IDs, names, and clef info from MusicXML for the Gemini prompt."""
        try:
            root = ET.fromstring(musicxml)
            # Handle both namespaced and non-namespaced MusicXML
            ns_prefix = "{http://www.musicxml.org/ns/}"
            parts = []
            score_parts = root.findall(f".//{ns_prefix}score-part")
            if not score_parts:
                score_parts = root.findall(".//score-part")
            for part in score_parts:
                pid = part.get("id", "")
                name_el = part.find(f"{ns_prefix}part-name") or part.find("part-name")
                name = name_el.text if name_el is not None else "Unknown"
                parts.append(f"{pid}: {name}")
            return "\n".join(parts) if parts else "(no parts found)"
        except Exception:
            return "(could not parse parts)"

    def _apply_corrections(self, musicxml: str, corrections: list) -> str:
        """Apply Gemini's targeted corrections to the MusicXML string."""
        result = musicxml
        for c in corrections:
            ctype = c.get("type", "")
            if ctype == "rename_part":
                current = c.get("current_value", "")
                correct = c.get("correct_value", "")
                if current and correct and current != correct:
                    result = result.replace(
                        f"<part-name>{current}</part-name>",
                        f"<part-name>{correct}</part-name>",
                    )
                    # Shorten abbreviation to first letter of the new voice name
                    result = result.replace(
                        f"<part-abbreviation>{current}</part-abbreviation>",
                        f"<part-abbreviation>{correct[:1]}</part-abbreviation>",
                    )
                    logger.info("Renamed part '%s' → '%s'", current, correct)
        return result

    # ------------------------------------------------------------------
    # Phase 2: measure-by-measure AI deep correction
    # ------------------------------------------------------------------

    def _deep_correct_musicxml(self, musicxml_path: str, pdf_path: str) -> str:
        """Orchestrate measure-by-measure AI cross-validation of MusicXML against the PDF.

        Compares PDF image crops against MusicXML note content for each batch of
        measures, uses Gemini Vision to detect discrepancies, and applies note-level
        corrections.  Returns the path to the corrected file, or the original path
        if any step fails.
        """
        if not _config.get("deep_correction_enabled", True):
            logger.info("[DeepCorrect] Deep correction disabled via config, skipping")
            return musicxml_path

        if GENAI_CLIENT is None:
            logger.info("[DeepCorrect] No Gemini client available, skipping")
            return musicxml_path

        try:
            with open(musicxml_path, "r", encoding="utf-8") as f:
                musicxml_text = f.read()

            # Enumerate measures in the first <part>
            try:
                root = ET.fromstring(musicxml_text)
            except ET.ParseError as e:
                logger.warning("[DeepCorrect] Cannot parse MusicXML: %s", e)
                return musicxml_path

            # Handle both namespaced and non-namespaced MusicXML
            ns_prefix = "{http://www.musicxml.org/ns/}"
            first_part = root.find(f".//{ns_prefix}part")
            if first_part is None:
                first_part = root.find(".//part")
            if first_part is None:
                logger.warning("[DeepCorrect] No <part> elements found in MusicXML")
                return musicxml_path

            part_id = first_part.get("id", "P1")
            measures_in_part = first_part.findall(f"{ns_prefix}measure")
            if not measures_in_part:
                measures_in_part = first_part.findall("measure")

            total_measures = len(measures_in_part)
            if total_measures == 0:
                logger.warning("[DeepCorrect] No measures found in first part")
                return musicxml_path

            logger.info(
                "[DeepCorrect] Starting deep correction: %d measures in part %s",
                total_measures, part_id,
            )

            batch_size = int(_config.get("deep_correction_batch_size", 4))
            all_corrections: list = []
            per_measure_confidence: list = []

            # Process in batches
            for batch_start in range(0, total_measures, batch_size):
                batch_end = min(batch_start + batch_size, total_measures)
                # MusicXML measure numbers are 1-based; list indices are 0-based
                measure_numbers = list(range(batch_start + 1, batch_end + 1))

                try:
                    image_bytes = self._crop_pdf_measures(pdf_path, measure_numbers, total_measures)
                    snippet = self._extract_musicxml_snippet(musicxml_text, part_id, measure_numbers)
                    result = self._verify_measure_with_ai(image_bytes, snippet, measure_numbers)

                    corrections = result.get("corrections", [])
                    confidence = result.get("confidence", 0.5)

                    logger.info(
                        "[DeepCorrect] Measures %s: confidence=%.2f, corrections=%d",
                        measure_numbers, confidence, len(corrections),
                    )

                    all_corrections.extend(corrections)
                    for mn in measure_numbers:
                        applied = sum(1 for c in corrections if c.get("measure") == mn)
                        per_measure_confidence.append({
                            "measure": mn,
                            "confidence": confidence,
                            "corrections_applied": applied,
                        })

                except Exception as e:
                    logger.warning(
                        "[DeepCorrect] Batch %s failed: %s — skipping batch",
                        measure_numbers, e,
                    )
                    for mn in measure_numbers:
                        per_measure_confidence.append({
                            "measure": mn,
                            "confidence": 0.5,
                            "corrections_applied": 0,
                        })
                    continue

            if not all_corrections:
                logger.info("[DeepCorrect] No corrections needed — MusicXML matches PDF")
                return musicxml_path

            logger.info("[DeepCorrect] Applying %d total correction(s)", len(all_corrections))
            corrected_xml = self._apply_deep_corrections(musicxml_text, all_corrections)

            # Validate before writing
            try:
                ET.fromstring(corrected_xml)
            except ET.ParseError as e:
                logger.warning("[DeepCorrect] Corrected XML invalid (%s), using original", e)
                return musicxml_path

            corrected_path = os.path.join(self.temp_dir, "deep_corrected_score.xml")
            with open(corrected_path, "w", encoding="utf-8") as f:
                f.write(corrected_xml)

            # Store per-measure confidence for the API endpoint
            self._deep_correction_confidence = {
                "overall": (
                    sum(m["confidence"] for m in per_measure_confidence) / len(per_measure_confidence)
                    if per_measure_confidence else 0.5
                ),
                "per_measure": per_measure_confidence,
            }

            logger.info(
                "[DeepCorrect] Deep correction complete — %d correction(s) applied, saved to %s",
                len(all_corrections), corrected_path,
            )
            return corrected_path

        except Exception as e:
            logger.warning("[DeepCorrect] Deep correction failed (%s), returning original", e)
            return musicxml_path

    def _crop_pdf_measures(
        self, pdf_path: str, measure_numbers: List[int], total_measures: int
    ) -> bytes:
        """Crop the relevant horizontal region of the PDF for the given measure numbers.

        Uses a proportional heuristic: divides the page width equally among all
        measures and crops the strip corresponding to the requested batch.  For
        multi-page scores the correct page is selected automatically.

        Returns JPEG bytes of the cropped region, or a full-page render as fallback.
        """
        try:
            doc = fitz.open(pdf_path)
            total_pages = len(doc)

            # Which page do these measures fall on?
            measures_per_page = max(1, total_measures / total_pages)
            # Use the middle measure of the batch to pick the page
            mid_measure = measure_numbers[len(measure_numbers) // 2]
            page_index = min(int((mid_measure - 1) / measures_per_page), total_pages - 1)

            page = doc[page_index]
            page_width = page.rect.width
            page_height = page.rect.height

            # Measures on this page (1-based)
            page_start_measure = int(page_index * measures_per_page) + 1
            measures_on_page = max(1, round(measures_per_page))

            # Normalise measure numbers to position within this page
            local_first = measure_numbers[0] - page_start_measure
            local_last = measure_numbers[-1] - page_start_measure

            x0 = max(0.0, local_first / measures_on_page * page_width)
            x1 = min(page_width, (local_last + 1) / measures_on_page * page_width)

            # Add small horizontal padding so we don't clip barlines
            padding = page_width * 0.01
            x0 = max(0.0, x0 - padding)
            x1 = min(page_width, x1 + padding)

            clip_rect = fitz.Rect(x0, 0, x1, page_height)
            matrix = fitz.Matrix(200 / 72, 200 / 72)
            pixmap = page.get_pixmap(clip=clip_rect, matrix=matrix)
            doc.close()
            return pixmap.tobytes("jpeg", jpg_quality=85)

        except Exception as e:
            logger.warning(
                "[DeepCorrect] Measure crop failed for measures %s (%s) — falling back to full page",
                measure_numbers, e,
            )
            try:
                doc = fitz.open(pdf_path)
                total_pages = len(doc)
                measures_per_page = max(1, total_measures / total_pages)
                mid_measure = measure_numbers[len(measure_numbers) // 2]
                page_index = min(int((mid_measure - 1) / measures_per_page), total_pages - 1)
                page = doc[page_index]
                matrix = fitz.Matrix(200 / 72, 200 / 72)
                pixmap = page.get_pixmap(matrix=matrix)
                doc.close()
                return pixmap.tobytes("jpeg", jpg_quality=85)
            except Exception as fallback_err:
                logger.error("[DeepCorrect] Full-page fallback also failed: %s", fallback_err)
                raise

    def _extract_musicxml_snippet(
        self, musicxml_text: str, part_id: str, measure_numbers: List[int]
    ) -> str:
        """Extract specific measures from a specific part in the MusicXML.

        Also prepends the <attributes> from measure 1 (key/time sig, clef) so
        that Gemini has full context even when the batch doesn't start at measure 1.
        Returns the snippet as an XML string.
        """
        try:
            root = ET.fromstring(musicxml_text)
        except ET.ParseError as e:
            logger.warning("[DeepCorrect] Cannot parse MusicXML for snippet extraction: %s", e)
            return musicxml_text[:4000]

        ns_prefix = "{http://www.musicxml.org/ns/}"

        # Find the requested part
        target_part = None
        for part in root.iter(f"{ns_prefix}part"):
            if part.get("id") == part_id:
                target_part = part
                break
        if target_part is None:
            for part in root.iter("part"):
                if part.get("id") == part_id:
                    target_part = part
                    break
        if target_part is None:
            # Fall back to first part
            target_part = root.find(f".//{ns_prefix}part")
            if target_part is None:
                target_part = root.find(".//part")
        if target_part is None:
            return musicxml_text[:4000]

        # Collect requested measures
        target_numbers_str = {str(n) for n in measure_numbers}
        selected_measures = []
        first_measure_attrs = None

        all_measures = target_part.findall(f"{ns_prefix}measure")
        if not all_measures:
            all_measures = target_part.findall("measure")

        for measure in all_measures:
            m_num = measure.get("number", "")
            # Grab attributes from measure 1 for context
            if m_num == "1":
                attrs_el = measure.find(f"{ns_prefix}attributes")
                if attrs_el is None:
                    attrs_el = measure.find("attributes")
                if attrs_el is not None:
                    first_measure_attrs = attrs_el
            if m_num in target_numbers_str:
                selected_measures.append(measure)

        if not selected_measures:
            logger.warning(
                "[DeepCorrect] No measures found for numbers %s in part %s",
                measure_numbers, part_id,
            )
            return ""

        # Build a minimal wrapper
        snippet_lines = [f'<part id="{part_id}">']
        for measure in selected_measures:
            measure_copy = copy.deepcopy(measure)
            # If this is not measure 1 and no attributes present, inject from measure 1
            if first_measure_attrs is not None and measure_copy.get("number") != "1":
                existing_attrs = (
                    measure_copy.find(f"{ns_prefix}attributes")
                    or measure_copy.find("attributes")
                )
                if existing_attrs is None:
                    measure_copy.insert(0, copy.deepcopy(first_measure_attrs))
            snippet_lines.append(ET.tostring(measure_copy, encoding="unicode"))
        snippet_lines.append("</part>")
        return "\n".join(snippet_lines)

    def _verify_measure_with_ai(
        self, image_bytes: bytes, musicxml_snippet: str, measure_numbers: List[int]
    ) -> dict:
        """Send a PDF image crop + MusicXML snippet to Gemini Vision for cross-validation.

        Returns a dict: {"corrections": [...], "confidence": float, "notes": str}.
        """
        if GENAI_CLIENT is None:
            return {"corrections": [], "confidence": 0.5, "notes": "Gemini client not available"}

        prompt_text = (
            "You are a music engraving expert. Compare the sheet music IMAGE against this MusicXML snippet.\n\n"
            f"MusicXML for measures {measure_numbers}:\n"
            f"{musicxml_snippet}\n\n"
            "Analyze the image and check if the MusicXML accurately represents what's written.\n\n"
            "For each discrepancy found, return a correction object:\n"
            '- "measure": measure number\n'
            '- "part_id": which part (e.g. "P1")\n'
            '- "type": one of "wrong_pitch", "wrong_rhythm", "missing_note", "extra_note",'
            ' "wrong_accidental", "wrong_rest"\n'
            '- "description": what\'s wrong and what it should be\n'
            '- "xpath": approximate XPath to the element to fix (e.g. "measure[3]/note[2]/pitch")\n'
            '- "current_value": what the MusicXML currently has\n'
            '- "correct_value": what it should be based on the image\n\n'
            "Also return:\n"
            '- "confidence": float 0.0-1.0 — how confident you are the MusicXML matches the image'
            ' (1.0 = perfect match)\n'
            '- "notes": brief human-readable summary\n\n'
            "Return ONLY valid JSON, no markdown fences:\n"
            '{"corrections": [...], "confidence": 0.95, "notes": "Measure 3 has a wrong note..."}'
        )

        model_name = _config.get("gemini_model_name", "gemini-2.0-flash")

        try:
            response = GENAI_CLIENT.models.generate_content(
                model=model_name,
                contents=[
                    genai_types.Part.from_bytes(data=image_bytes, mime_type="image/jpeg"),
                    prompt_text,
                ],
                config=genai_types.GenerateContentConfig(
                    max_output_tokens=4096,
                    temperature=0.1,
                ),
            )

            response_text = response.text.strip()
            logger.info(
                "[DeepCorrect] AI response for measures %s: %s",
                measure_numbers, response_text[:300],
            )

            # Strip markdown fences if present
            if response_text.startswith("```"):
                lines = response_text.split("\n")
                lines = lines[1:]
                if lines and lines[-1].strip() == "```":
                    lines = lines[:-1]
                response_text = "\n".join(lines).strip()

            result = json.loads(response_text)
            if not isinstance(result, dict):
                raise ValueError(f"Expected JSON object, got {type(result)}")

            # Normalise missing keys
            result.setdefault("corrections", [])
            result.setdefault("confidence", 0.5)
            result.setdefault("notes", "")
            return result

        except (json.JSONDecodeError, ValueError) as e:
            logger.warning(
                "[DeepCorrect] Could not parse AI response for measures %s: %s",
                measure_numbers, e,
            )
            return {
                "corrections": [],
                "confidence": 0.5,
                "notes": "AI response could not be parsed",
            }

    def _apply_deep_corrections(self, musicxml_text: str, all_corrections: list) -> str:
        """Apply note-level corrections from the AI to the MusicXML.

        Uses ElementTree XML manipulation (never string replacement).  Validates
        the result before returning; falls back to the original if invalid.
        """
        if not all_corrections:
            return musicxml_text

        try:
            root = ET.fromstring(musicxml_text)
        except ET.ParseError as e:
            logger.warning("[DeepCorrect] Cannot parse MusicXML for corrections: %s", e)
            return musicxml_text

        ns_prefix = "{http://www.musicxml.org/ns/}"
        applied = 0

        for correction in all_corrections:
            ctype = correction.get("type", "")
            measure_num = str(correction.get("measure", ""))
            part_id = correction.get("part_id", "")
            description = correction.get("description", "")

            if not measure_num:
                continue

            # Locate the target part
            target_part = None
            if part_id:
                for p in root.iter(f"{ns_prefix}part"):
                    if p.get("id") == part_id:
                        target_part = p
                        break
                if target_part is None:
                    for p in root.iter("part"):
                        if p.get("id") == part_id:
                            target_part = p
                            break
            if target_part is None:
                target_part = root.find(f".//{ns_prefix}part")
                if target_part is None:
                    target_part = root.find(".//part")
            if target_part is None:
                continue

            # Locate the target measure
            target_measure = None
            for m in target_part.iter(f"{ns_prefix}measure"):
                if m.get("number") == measure_num:
                    target_measure = m
                    break
            if target_measure is None:
                for m in target_part.iter("measure"):
                    if m.get("number") == measure_num:
                        target_measure = m
                        break
            if target_measure is None:
                logger.warning(
                    "[DeepCorrect] Measure %s not found in part %s — skipping correction",
                    measure_num, part_id,
                )
                continue

            # Collect notes/rests in this measure
            notes_in_measure = (
                target_measure.findall(f"{ns_prefix}note")
                or target_measure.findall("note")
            )

            try:
                if ctype == "wrong_pitch":
                    # Update pitch of the first eligible note
                    correct_val = correction.get("correct_value", "")
                    # correct_value format: "C#4" or "D4" or step/octave
                    for note_el in notes_in_measure:
                        pitch_el = note_el.find(f"{ns_prefix}pitch") or note_el.find("pitch")
                        if pitch_el is None:
                            continue
                        if correct_val and len(correct_val) >= 2:
                            # Parse simple pitch notation: e.g. "C#4", "Bb3", "D4"
                            step = correct_val[0].upper()
                            rest_str = correct_val[1:]
                            alter = 0
                            octave_str = ""
                            if rest_str.startswith("#"):
                                alter = 1
                                octave_str = rest_str[1:]
                            elif rest_str.startswith("b") or rest_str.startswith("♭"):
                                alter = -1
                                octave_str = rest_str[1:]
                            elif rest_str.startswith("x"):
                                alter = 2
                                octave_str = rest_str[1:]
                            elif rest_str.startswith("bb"):
                                alter = -2
                                octave_str = rest_str[2:]
                            else:
                                octave_str = rest_str

                            step_el = pitch_el.find(f"{ns_prefix}step") or pitch_el.find("step")
                            octave_el = pitch_el.find(f"{ns_prefix}octave") or pitch_el.find("octave")
                            alter_el = pitch_el.find(f"{ns_prefix}alter") or pitch_el.find("alter")

                            if step_el is not None:
                                step_el.text = step
                            if octave_el is not None and octave_str.isdigit():
                                octave_el.text = octave_str
                            if alter != 0:
                                if alter_el is None:
                                    alter_el = ET.SubElement(pitch_el, "alter")
                                alter_el.text = str(alter)
                            elif alter_el is not None:
                                pitch_el.remove(alter_el)
                        logger.info(
                            "[DeepCorrect] wrong_pitch applied in measure %s: %s",
                            measure_num, description,
                        )
                        applied += 1
                        break  # only fix the first note per correction

                elif ctype == "wrong_rhythm":
                    correct_val = correction.get("correct_value", "")
                    for note_el in notes_in_measure:
                        dur_el = note_el.find(f"{ns_prefix}duration") or note_el.find("duration")
                        type_el = note_el.find(f"{ns_prefix}type") or note_el.find("type")
                        if dur_el is not None and correct_val:
                            # correct_value may be a type name like "quarter" or a number
                            if correct_val.isdigit():
                                dur_el.text = correct_val
                            elif type_el is not None:
                                type_el.text = correct_val
                        logger.info(
                            "[DeepCorrect] wrong_rhythm applied in measure %s: %s",
                            measure_num, description,
                        )
                        applied += 1
                        break

                elif ctype == "wrong_accidental":
                    correct_val = correction.get("correct_value", "")
                    for note_el in notes_in_measure:
                        pitch_el = note_el.find(f"{ns_prefix}pitch") or note_el.find("pitch")
                        if pitch_el is None:
                            continue
                        alter_el = pitch_el.find(f"{ns_prefix}alter") or pitch_el.find("alter")
                        acc_el = note_el.find(f"{ns_prefix}accidental") or note_el.find("accidental")
                        accidental_map = {
                            "#": ("1", "sharp"), "b": ("-1", "flat"),
                            "sharp": ("1", "sharp"), "flat": ("-1", "flat"),
                            "natural": ("0", "natural"), "n": ("0", "natural"),
                            "x": ("2", "double-sharp"), "bb": ("-2", "flat-flat"),
                        }
                        if correct_val.lower() in accidental_map:
                            alter_val, acc_name = accidental_map[correct_val.lower()]
                            if alter_el is None:
                                alter_el = ET.SubElement(pitch_el, "alter")
                            alter_el.text = alter_val
                            if acc_el is not None:
                                acc_el.text = acc_name
                        logger.info(
                            "[DeepCorrect] wrong_accidental applied in measure %s: %s",
                            measure_num, description,
                        )
                        applied += 1
                        break

                elif ctype == "extra_note":
                    # Remove the last note in the measure (best-effort heuristic)
                    if notes_in_measure:
                        target_measure.remove(notes_in_measure[-1])
                        logger.info(
                            "[DeepCorrect] extra_note removed in measure %s: %s",
                            measure_num, description,
                        )
                        applied += 1

                elif ctype == "missing_note":
                    # Append a placeholder note (C4 quarter) — human review will refine
                    correct_val = correction.get("correct_value", "C4")
                    new_note = ET.SubElement(target_measure, "note")
                    pitch_el = ET.SubElement(new_note, "pitch")
                    step_el = ET.SubElement(pitch_el, "step")
                    step_el.text = correct_val[0].upper() if correct_val else "C"
                    octave_el = ET.SubElement(pitch_el, "octave")
                    octave_el.text = correct_val[-1] if correct_val and correct_val[-1].isdigit() else "4"
                    dur_el = ET.SubElement(new_note, "duration")
                    dur_el.text = "1"
                    type_el = ET.SubElement(new_note, "type")
                    type_el.text = "quarter"
                    logger.info(
                        "[DeepCorrect] missing_note inserted in measure %s: %s",
                        measure_num, description,
                    )
                    applied += 1

                elif ctype == "wrong_rest":
                    # Toggle first note↔rest in the measure
                    for note_el in notes_in_measure:
                        rest_el = note_el.find(f"{ns_prefix}rest") or note_el.find("rest")
                        pitch_el = note_el.find(f"{ns_prefix}pitch") or note_el.find("pitch")
                        if rest_el is not None and pitch_el is None:
                            # It's a rest — convert to a placeholder note (C4)
                            note_el.remove(rest_el)
                            new_pitch = ET.SubElement(note_el, "pitch")
                            ET.SubElement(new_pitch, "step").text = "C"
                            ET.SubElement(new_pitch, "octave").text = "4"
                        elif pitch_el is not None and rest_el is None:
                            # It's a note — convert to rest
                            note_el.remove(pitch_el)
                            ET.SubElement(note_el, "rest")
                        logger.info(
                            "[DeepCorrect] wrong_rest toggled in measure %s: %s",
                            measure_num, description,
                        )
                        applied += 1
                        break

                else:
                    logger.info(
                        "[DeepCorrect] Unknown correction type %r in measure %s — skipping",
                        ctype, measure_num,
                    )

            except Exception as e:
                logger.warning(
                    "[DeepCorrect] Error applying correction type=%r measure=%s: %s",
                    ctype, measure_num, e,
                )
                continue

        if applied == 0:
            logger.info("[DeepCorrect] No corrections were applied")
            return musicxml_text

        corrected = ET.tostring(root, encoding="unicode")

        # Validate before returning
        try:
            ET.fromstring(corrected)
        except ET.ParseError as e:
            logger.warning("[DeepCorrect] Corrected XML is invalid (%s), returning original", e)
            return musicxml_text

        logger.info("[DeepCorrect] Applied %d correction(s) successfully", applied)
        return corrected

    def process_pdf(self, pdf_path: str) -> str:
        """Convert PDF to MusicXML using Audiveris OMR. Returns path to generated MusicXML."""
        if not os.path.exists(pdf_path):
            raise ValueError(f"PDF file not found: {pdf_path}")
        if not os.path.isfile(pdf_path):
            raise ValueError(f"Path is not a file: {pdf_path}")
        if not pdf_path.lower().endswith('.pdf'):
            raise ValueError(f"File must be a PDF: {pdf_path}")

        doc = fitz.open(pdf_path)
        total_pages = len(doc)
        doc.close()

        if total_pages == 0:
            raise ValueError("Could not extract pages from PDF")

        warnings = []
        if total_pages > PDF_MAX_PAGES:
            warnings.append(f"PDF has {total_pages} pages; only first {PDF_MAX_PAGES} will be processed")

        # Step 1: Run Audiveris local OMR
        musicxml_path = self._run_audiveris(pdf_path)
        logger.info("Audiveris produced MusicXML: %s", musicxml_path)

        # Step 2: AI refinement (optional — only if Gemini API key is set)
        if GENAI_CLIENT is not None:
            try:
                musicxml_path = self._refine_musicxml(musicxml_path, pdf_path)
                logger.info("AI refinement completed")
            except Exception as e:
                logger.warning("AI refinement failed, using raw Audiveris output: %s", e)
        else:
            logger.info("No Gemini API key — skipping AI refinement")

        # Step 3: Deep AI cross-validation (note-level corrections)
        if GENAI_CLIENT is not None:
            try:
                musicxml_path = self._deep_correct_musicxml(musicxml_path, pdf_path)
                logger.info("Deep AI correction completed")
            except Exception as e:
                logger.warning("Deep AI correction failed, using previous output: %s", e)

        self._pdf_warnings = warnings
        return musicxml_path

    def _process_pdf_gemini(self, pdf_path: str) -> str:
        """
        [LEGACY] Convert PDF to MusicXML using Gemini Vision OMR.
        Preserved as fallback reference. Use process_pdf() instead.
        Returns path to generated MusicXML file.
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
            model_name = _config.get("gemini_model_name", "gemini-2.0-flash")
            max_output_tokens = int(_config.get("gemini_max_output_tokens", 8192))

            # Retry with progressively fewer pages if Gemini truncates its output
            # (finish_reason == MAX_TOKENS). Attempts: all pages → N//2 → 1.
            current_pages = page_limit
            content = None
            for attempt in range(3):
                retry_pages = jpeg_pages[:current_pages]
                page_note = (
                    f"This score spans {len(retry_pages)} page(s) — all pages are provided in order."
                    if len(retry_pages) == total_pages else
                    f"The first {len(retry_pages)} of {total_pages} pages are provided in order."
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

                retry_image_parts = [
                    genai_types.Part.from_bytes(data=b, mime_type="image/jpeg")
                    for b in retry_pages
                ]

                logger.info(
                    "Gemini OMR attempt %d/%d: %d page(s), max_output_tokens=%d",
                    attempt + 1, 3, len(retry_pages), max_output_tokens,
                )
                response = GENAI_CLIENT.models.generate_content(
                    model=model_name,
                    contents=[prompt, *retry_image_parts],
                    config=genai_types.GenerateContentConfig(
                        max_output_tokens=max_output_tokens,
                    ),
                )

                # Detect truncation: if finish_reason is MAX_TOKENS the response was
                # cut off mid-XML. Retry with half as many pages to fit the limit.
                finish_reason = ""
                if response.candidates:
                    finish_reason = str(response.candidates[0].finish_reason)

                if "MAX_TOKENS" in finish_reason and current_pages > 1:
                    new_pages = max(1, current_pages // 2)
                    logger.warning(
                        "Gemini output truncated (MAX_TOKENS) on attempt %d with %d pages. "
                        "Retrying with %d page(s).",
                        attempt + 1, current_pages, new_pages,
                    )
                    current_pages = new_pages
                    continue

                content = response.text
                break

            if content is None:
                raise RuntimeError(
                    "Gemini output was truncated even when processing a single page. "
                    "The score may be too dense for the model's output limit."
                )

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
from fastapi import FastAPI, File, UploadFile, HTTPException, Form, Depends, Header, Request
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
            warnings = getattr(processor, '_pdf_warnings', [])
            analysis = processor.analyze_musicxml(musicxml_path)
            confidence = getattr(processor, '_deep_correction_confidence', None)
            with open(musicxml_path, 'r', encoding="utf-8") as f:
                musicxml_content = f.read()
            return {"success": True, "musicxml": musicxml_content, "analysis": analysis, "warnings": warnings, "confidence": confidence}

    try:
        result = await asyncio.wait_for(asyncio.to_thread(_run), timeout=180)
        return JSONResponse(result)
    except asyncio.TimeoutError:
        logger.error("Processing timed out")
        raise HTTPException(504, detail=json.dumps({
            "error_category": "network",
            "error_message": "Processing timed out. The score may be too complex — try fewer pages.",
        }))
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Error processing PDF: %s", e, exc_info=True)
        category, safe_message = _classify_error(e)
        raise HTTPException(500, detail=json.dumps({
            "error_category": category,
            "error_message": safe_message,
        }))


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
        result = await asyncio.wait_for(asyncio.to_thread(_run), timeout=120)
        return JSONResponse(result)
    except asyncio.TimeoutError:
        logger.error("Processing timed out")
        raise HTTPException(504, detail=json.dumps({
            "error_category": "network",
            "error_message": "Processing timed out. The score may be too complex — try fewer pages.",
        }))
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Error processing MusicXML: %s", e, exc_info=True)
        category, safe_message = _classify_error(e)
        raise HTTPException(500, detail=json.dumps({
            "error_category": category,
            "error_message": safe_message,
        }))


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
                    content = f.read()
                if len(content) == 0:
                    logger.warning("Empty MIDI file generated for voice: %s", voice_type)
                    continue
                midi_data[voice_type] = base64.b64encode(content).decode('utf-8')

            if not midi_data:
                raise Exception("No MIDI data could be generated from the score.")
            return {"success": True, "midi_files": midi_data}

    try:
        result = await asyncio.wait_for(asyncio.to_thread(_run), timeout=60)
        return JSONResponse(result)
    except asyncio.TimeoutError:
        logger.error("Processing timed out")
        raise HTTPException(504, detail=json.dumps({
            "error_category": "network",
            "error_message": "Processing timed out. The score may be too complex — try fewer pages.",
        }))
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Error generating MIDI: %s", e, exc_info=True)
        category, safe_message = _classify_error(e)
        raise HTTPException(500, detail=json.dumps({
            "error_category": category,
            "error_message": safe_message,
        }))


@app.get("/health")
async def health_check():
    """Health check endpoint — intentionally unauthenticated so the Node.js
    server can probe it without needing to set up auth headers."""
    gemini_configured = bool(_config.get("gemini_api_key"))

    return {
        "status": "healthy",
        "gemini_configured": gemini_configured,
    }


@app.post("/api/update-config")
async def update_config(
    request: Request,
    _: None = Depends(verify_internal_token),
):
    """Update Gemini runtime configuration without restarting.

    Accepts JSON body with optional keys: gemini_api_key, gemini_model_name,
    gemini_max_output_tokens. Only provided keys are updated.
    """
    body = await request.json()

    if "gemini_api_key" in body and isinstance(body["gemini_api_key"], str):
        _config["gemini_api_key"] = body["gemini_api_key"]
    if "gemini_model_name" in body and isinstance(body["gemini_model_name"], str):
        _config["gemini_model_name"] = body["gemini_model_name"]
    if "gemini_max_output_tokens" in body:
        try:
            _config["gemini_max_output_tokens"] = int(body["gemini_max_output_tokens"])
        except (ValueError, TypeError):
            pass

    _rebuild_genai_client()
    logger.info("Gemini config updated at runtime (key=%s, model=%s, tokens=%s)",
                "***" if _config.get("gemini_api_key") else "<unset>",
                _config.get("gemini_model_name"),
                _config.get("gemini_max_output_tokens"))

    # Validate model name if client is available and model was changed
    if "gemini_model_name" in body and GENAI_CLIENT:
        try:
            GENAI_CLIENT.models.get(model=_config["gemini_model_name"])
        except Exception as e:
            logger.warning("Model validation failed for '%s': %s", _config["gemini_model_name"], e)
            # Don't block the save — just warn via response
            return {"success": True, "warning": f"Model '{_config['gemini_model_name']}' could not be validated: {str(e)}"}

    return {"success": True}


@app.post("/api/test-gemini")
async def test_gemini(
    _: None = Depends(verify_internal_token),
):
    """Test that the current Gemini API key and model are valid."""
    if not GENAI_CLIENT:
        raise HTTPException(400, detail="Gemini API key is not configured.")

    try:
        model_name = _config.get("gemini_model_name", "gemini-2.0-flash")
        model_info = GENAI_CLIENT.models.get(model=model_name)
        return {
            "success": True,
            "model": model_info.name if hasattr(model_info, "name") else model_name,
        }
    except Exception as e:
        logger.error("Gemini connection test failed: %s", e, exc_info=True)
        category, safe_message = _classify_error(e)
        raise HTTPException(400, detail=json.dumps({
            "error_category": category,
            "error_message": safe_message,
        }))


@app.post("/api/deep-correct")
async def deep_correct(
    musicxml: str = Form(...),
    file: UploadFile = File(...),
    _: None = Depends(verify_internal_token),
):
    """Manually re-run the deep AI correction on existing MusicXML + its original PDF.

    Accepts:
        musicxml (form field): MusicXML content as a string
        file (upload):         Original PDF used to produce the MusicXML

    Returns corrected MusicXML and per-measure confidence data.
    """
    if not file.filename.lower().endswith(".pdf"):
        raise HTTPException(400, "file must be a PDF")

    if len(musicxml) > 50 * 1024 * 1024:
        raise HTTPException(413, "MusicXML content too large. Maximum size is 50MB")

    pdf_content = await file.read()
    if len(pdf_content) > 50 * 1024 * 1024:
        raise HTTPException(413, "PDF too large. Maximum size is 50MB")

    if GENAI_CLIENT is None:
        raise HTTPException(400, detail=json.dumps({
            "error_category": "api_key",
            "error_message": "Gemini API key is not configured. Deep correction requires a Gemini API key.",
        }))

    def _run():
        with create_temp_processor() as processor:
            # Write the uploaded PDF to a temp file
            pdf_path = os.path.join(processor.temp_dir, "input.pdf")
            with open(pdf_path, "wb") as f:
                f.write(pdf_content)

            # Write the provided MusicXML to a temp file
            musicxml_path = os.path.join(processor.temp_dir, "score_input.xml")
            with open(musicxml_path, "w", encoding="utf-8") as f:
                f.write(musicxml)

            corrected_path = processor._deep_correct_musicxml(musicxml_path, pdf_path)
            with open(corrected_path, "r", encoding="utf-8") as f:
                corrected_xml = f.read()

            confidence = getattr(processor, "_deep_correction_confidence", {
                "overall": 0.5,
                "per_measure": [],
            })

            return {
                "success": True,
                "musicxml": corrected_xml,
                "confidence": confidence,
            }

    try:
        result = await asyncio.wait_for(asyncio.to_thread(_run), timeout=300)
        return JSONResponse(result)
    except asyncio.TimeoutError:
        logger.error("Deep correction timed out")
        raise HTTPException(504, detail=json.dumps({
            "error_category": "network",
            "error_message": "Deep correction timed out. The score may be too large — try fewer pages.",
        }))
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Error during deep correction: %s", e, exc_info=True)
        category, safe_message = _classify_error(e)
        raise HTTPException(500, detail=json.dumps({
            "error_category": category,
            "error_message": safe_message,
        }))


if __name__ == "__main__":
    port = int(os.environ.get("PYTHON_SERVICE_PORT", 8001))
    uvicorn.run(app, host="0.0.0.0", port=port)
