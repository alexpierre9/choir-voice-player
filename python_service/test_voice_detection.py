"""
Unit tests for voice detection algorithm in music_processor.py
"""
import unittest
from music_processor import MusicProcessor, VoiceType


class TestVoiceDetection(unittest.TestCase):
    def setUp(self):
        self.processor = MusicProcessor()

    def test_part_name_detection(self):
        """Test that part names correctly identify voice types"""
        # Test soprano detection
        result = self.processor._detect_voice_type("Soprano", "treble", (60, 72))
        self.assertEqual(result, VoiceType.SOPRANO)

        # Test alto detection
        result = self.processor._detect_voice_type("Alto", "treble", (55, 67))
        self.assertEqual(result, VoiceType.ALTO)

        # Test tenor detection
        result = self.processor._detect_voice_type("Tenor", "treble", (48, 60))
        self.assertEqual(result, VoiceType.TENOR)

        # Test bass detection
        result = self.processor._detect_voice_type("Bass", "bass", (40, 52))
        self.assertEqual(result, VoiceType.BASS)

        # Test abbreviated names
        result = self.processor._detect_voice_type("Sop", "treble", (60, 72))
        self.assertEqual(result, VoiceType.SOPRANO)

        result = self.processor._detect_voice_type("Alt", "treble", (55, 67))
        self.assertEqual(result, VoiceType.ALTO)

        result = self.processor._detect_voice_type("Ten", "treble", (48, 60))
        self.assertEqual(result, VoiceType.TENOR)

        result = self.processor._detect_voice_type("Bas", "bass", (40, 52))
        self.assertEqual(result, VoiceType.BASS)

        # Test additional keywords
        result = self.processor._detect_voice_type("S.", "treble", (60, 72))
        self.assertEqual(result, VoiceType.SOPRANO)

        result = self.processor._detect_voice_type("A.", "treble", (55, 67))
        self.assertEqual(result, VoiceType.ALTO)

        result = self.processor._detect_voice_type("T.", "treble", (48, 60))
        self.assertEqual(result, VoiceType.TENOR)

        result = self.processor._detect_voice_type("B.", "bass", (40, 52))
        self.assertEqual(result, VoiceType.BASS)

        # Test contralto
        result = self.processor._detect_voice_type("Contralto", "treble", (55, 67))
        self.assertEqual(result, VoiceType.ALTO)

        # Test baritone
        result = self.processor._detect_voice_type("Baritone", "bass", (45, 57))
        self.assertEqual(result, VoiceType.TENOR)

    def test_clef_based_detection(self):
        """Test that clef types help identify voice types when no name is available"""
        # Treble clef should suggest soprano/alto
        result = self.processor._detect_voice_type("Part 1", "treble", (60, 72))
        self.assertIn(result, [VoiceType.SOPRANO, VoiceType.ALTO])

        # Bass clef should suggest tenor/bass
        result = self.processor._detect_voice_type("Part 1", "bass", (40, 52))
        self.assertIn(result, [VoiceType.TENOR, VoiceType.BASS])

    def test_pitch_range_detection(self):
        """Test that pitch ranges correctly identify voice types"""
        # Test soprano range
        result = self.processor._detect_voice_type("Part 1", "unknown", (60, 81))  # C4 to A5
        self.assertEqual(result, VoiceType.SOPRANO)

        # Test alto range
        result = self.processor._detect_voice_type("Part 1", "unknown", (55, 76))  # G3 to E5
        self.assertEqual(result, VoiceType.ALTO)

        # Test tenor range
        result = self.processor._detect_voice_type("Part 1", "unknown", (48, 69))  # C3 to A4
        self.assertEqual(result, VoiceType.TENOR)

        # Test bass range
        result = self.processor._detect_voice_type("Part 1", "unknown", (40, 64))  # E2 to E4
        self.assertEqual(result, VoiceType.BASS)

    def test_edge_cases(self):
        """Test edge cases and unusual scenarios"""
        # Mixed clef and range - name should take priority
        result = self.processor._detect_voice_type("Soprano", "bass", (40, 52))
        self.assertEqual(result, VoiceType.SOPRANO)

        # Unusual pitch range (countertenor, etc.)
        result = self.processor._detect_voice_type("Voice 1", "treble", (50, 70))
        # Should be detected as tenor due to range overlap
        self.assertNotEqual(result, VoiceType.OTHER)

        # Missing part names
        result = self.processor._detect_voice_type("", "treble", (60, 72))
        # Should fall back to clef-based detection
        self.assertIn(result, [VoiceType.SOPRANO, VoiceType.ALTO])

        # Completely unknown
        result = self.processor._detect_voice_type("Unknown", "unknown", (0, 10))
        self.assertEqual(result, VoiceType.OTHER)

    def test_overlap_threshold(self):
        """Test that the 30% overlap threshold works correctly"""
        # Test with range that barely meets threshold for soprano
        # Soprano range is (60, 81), so a range that overlaps by ~30% should be detected
        result = self.processor._detect_voice_type("Part 1", "unknown", (75, 81))  # Mostly in soprano range
        self.assertEqual(result, VoiceType.SOPRANO)

        # Test with range that doesn't meet threshold
        # Very small range that doesn't significantly overlap with any voice
        result = self.processor._detect_voice_type("Part 1", "unknown", (30, 32))  # Very low, doesn't match any voice well
        # Should fall back to clef-based detection if clef is known
        # Or to OTHER if no clear match


if __name__ == '__main__':
    unittest.main()