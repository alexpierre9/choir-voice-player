# PLAN — SATB Processing Accuracy Improvements

**Source document:** `docs/satb_notation_reference.md`
**Complexity tier:** M (1 primary file, 2 integration points, stateless per-request)

## Assumptions

1. `music21 9.1.0` has `clef.Treble8vbClef` (confirmed: present since v5).
2. The primary pipeline path is PDF → Gemini → MusicXML → analysis → MIDI.
   A better Gemini prompt has the highest single-task leverage.
3. Multi-voice (short score) MusicXML is important for user-uploaded `.xml/.musicxml` files.
4. The `index` field in `parts_info` stays as a sequential integer — no breaking
   API change needed for the frontend or `routers.ts`.
5. Tenor octave correction (-12 semitones) applies only when `clef == "treble8vb"`
   AND the part has no `<transpose>` element. music21 auto-applies `<transpose>` on parse.

## Dimension Scores

| Dimension         | Level  |
|-------------------|--------|
| File count        | Low    |
| Integration pts   | Medium |
| State management  | Low    |
| Auth              | Low    |
| Data model        | Low    |
| Concurrency       | Low    |

## Milestones

- [x] M0 — Plan written
- [ ] M1 — Voice ranges + tenor 8vb clef detection (quick wins)
- [ ] M2 — Gemini OMR prompt overhaul
- [ ] M3 — Multi-voice part analysis in `analyze_musicxml`
- [ ] M4 — `generate_midi_files` updated for multi-voice parts
- [ ] M5 — Verify + deliver

## Files Modified

- `python_service/music_processor.py` — all changes

## Pivot Log

*(empty)*
