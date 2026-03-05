# SATB Sheet Music — Comprehensive Notation Reference
> **Purpose:** Deep research document to guide accurate SATB voice extraction during PDF processing.
> Compiled from music theory literature, choral notation standards, and OMR research (Feb 2026).

---

## Table of Contents

1. [What is SATB?](#1-what-is-satb)
2. [Score Formats](#2-score-formats)
3. [Clef Conventions](#3-clef-conventions)
4. [Voice Ranges](#4-voice-ranges)
5. [Stem Direction Rules](#5-stem-direction-rules)
6. [Rest Notation per Voice](#6-rest-notation-per-voice)
7. [Shared-Staff Ambiguities](#7-shared-staff-ambiguities)
8. [Lyrics Placement](#8-lyrics-placement)
9. [Ties vs Slurs](#9-ties-vs-slurs)
10. [Beaming Conventions](#10-beaming-conventions)
11. [Divisi and Voice Splitting](#11-divisi-and-voice-splitting)
12. [Articulation Marks](#12-articulation-marks)
13. [Fermata and Breath Marks](#13-fermata-and-breath-marks)
14. [Rehearsal Marks and Navigation Symbols](#14-rehearsal-marks-and-navigation-symbols)
15. [Dynamic Markings in SATB](#15-dynamic-markings-in-satb)
16. [MusicXML Voice Encoding](#16-musicxml-voice-encoding)
17. [OMR Processing Challenges](#17-omr-processing-challenges)
18. [Voice Validation Rules](#18-voice-validation-rules)
19. [Quick Reference Cheat Sheet](#19-quick-reference-cheat-sheet)

---

## 1. What is SATB?

**SATB** stands for:
- **S**oprano — highest female voice
- **A**lto — lower female voice
- **T**enor — highest male voice
- **B**ass — lowest male voice

These four voice parts form the backbone of Western choral music. They are often combined into a **grand staff** (two staves joined by a brace) or written on four separate staves.

---

## 2. Score Formats

### 2.1 Short Score (Closed Score)
The most common format in print. **All four parts are compressed onto two staves (a grand staff)**:

```
┌─────────────────────────────────┐
│  Treble clef  │  Soprano (stems ↑) + Alto (stems ↓)
├─────────────────────────────────┤
│  Bass clef    │  Tenor  (stems ↑) + Bass  (stems ↓)
└─────────────────────────────────┘
```

- Looks identical to a piano score visually — the crucial difference is the **two voices per staff** encoded only by stem direction.
- Very compact — a page covers more measures.
- Stems always follow the SATB rule (see §5), not the normal pitch-position rule.

### 2.2 Open Score
Each voice gets **its own dedicated staff** — 4 staves per system:

```
Staff 1: Soprano  (treble clef)
Staff 2: Alto     (treble clef)
Staff 3: Tenor    (octave treble clef, 8vb)
Staff 4: Bass     (bass clef)
```

- Clearest for individual singers to read their own part.
- Stem direction follows standard single-voice rules (pitch position relative to middle line).
- Common in academic editions and older choral scores.

### 2.3 Vocal Score (Piano-Vocal Score)
Used for rehearsals of large works (oratorios, musicals, operas):

- Top section: Full SATB choral parts (usually short score or open score).
- Bottom section: Piano accompaniment (keyboard reduction of the orchestra), written on a grand staff.
- The piano staves are **not a separate voice** — they are an orchestral reduction.

### 2.4 Hybrid Formats
Some modern scores use:
- **SA on treble + TB on bass** (short score) **WITH** individual open-score pages for rehearsal.
- **SATB + Piano** on 3 staves (SA on treble, TB on bass, Piano on grand staff below, connected by a common bracket).

---

## 3. Clef Conventions

| Voice | Standard Clef | Notes |
|-------|--------------|-------|
| **Soprano** | Treble clef (𝄞) | Writes and sounds at concert pitch |
| **Alto** | Treble clef (𝄞) | Writes and sounds at concert pitch |
| **Tenor** | **Octave treble clef (𝄬, "8vb treble")** | Written in treble; **sounds one octave lower** |
| **Tenor** (alternate) | C clef on 4th line (tenor C clef) | Used in historical/academic open scores; actual sounding pitch |
| **Bass** | Bass clef (𝄢) | Writes and sounds at concert pitch |

### ⚠️ Critical: The Tenor Octave Transposition
The **octave treble clef** (treble clef with a small `8` below) is the **most common trap** in SATB processing:
- A note written on the C just above the treble staff (C5) **actually sounds as C4 (middle C)** for tenors.
- If your system reads tenor notes as treble-pitch values, all tenor pitches will be **one octave too high**.
- **Rule:** When the tenor staff uses the `8vb` treble clef, subtract 12 semitones from all read MIDI values.
- When a standard treble clef is used for tenor (no `8` marker), this is a **notation error** or an older/simplified version — still interpret as sounding one octave lower in practice.

---

## 4. Voice Ranges

These are **practical choral ranges** (not solo operatic ranges). All pitches in scientific notation (C4 = Middle C).

| Voice | Lowest Note | Highest Note | Comfortable Tessitura | Clef Written | Sounds |
|-------|------------|-------------|----------------------|-------------|--------|
| **Soprano** | C4 (Middle C) | A5 (or C6 advanced) | E4 – G5 | Treble | At pitch |
| **Alto** | G3 | D5 (E5 advanced) | B3 – B4 | Treble | At pitch |
| **Tenor** | C3 | G4 (B4 advanced) | E3 – E4 | 8vb Treble | 8va lower than written |
| **Bass** | E2 (D2 advanced) | C4 (Middle C) | G2 – E3 | Bass | At pitch |

### Range Overlap Zones
- Alto and Tenor overlap significantly around **G3–D4** — this is a key challenge for voice separation.
- Soprano and Alto share **C4–D5**.
- Use context (clef, stem direction, staff position) not just pitch to identify voice.

### Out-of-Range Warnings (for algorithmic validation)
| Voice | Suspicious if below | Suspicious if above |
|-------|---------------------|---------------------|
| Soprano | A3 | D6 |
| Alto | E3 | G5 |
| Tenor (sounding) | A2 | C5 |
| Bass | B1 | F4 |

---

## 5. Stem Direction Rules

### 5.1 Short Score (Two Voices Per Staff) — Primary Rule
**This is the most important rule for PDF processing:**

| Staff | Voice | Stem Direction | Overrides pitch-position? |
|-------|-------|---------------|--------------------------|
| Treble | Soprano | **Always UP ↑** | **YES** |
| Treble | Alto | **Always DOWN ↓** | **YES** |
| Bass | Tenor | **Always UP ↑** | **YES** |
| Bass | Bass | **Always DOWN ↓** | **YES** |

The stem direction in short scores is **absolute and always determines voice identity**, regardless of where the note sits on the staff. A soprano note on the bottom ledger line will still have stem UP.

### 5.2 Open Score (One Voice Per Staff) — Secondary Rule
In open score, standard notation rules apply:
- Notes **below** the middle line (B4 on treble, D3 on bass) → stems point **UP ↑**
- Notes **on or above** the middle line → stems point **DOWN ↓**
- Middle line notes: stem direction matches surrounding context

### 5.3 Shared Noteheads (Unison Notes)
When both voices on a staff sing the **same pitch**:
- One notehead with **two stems** (one up, one down) extending from the same notehead.
- This indicates **both voices sing this note simultaneously** at the same pitch.
- Both rhythmic values may differ → watch for different stem-flag counts on each stem.

---

## 6. Rest Notation per Voice

### 6.1 Short Score Rest Placement
When one voice rests while the other continues:

| Voice | Rest Position | Detail |
|-------|--------------|--------|
| Soprano (top voice) | **Above center** of treble staff | Rests attach to the top of the staff area |
| Alto (bottom voice) | **Below center** of treble staff | Rests hang below staff center |
| Tenor (top voice) | **Above center** of bass staff | Same convention as soprano on their staff |
| Bass (bottom voice) | **Below center** of bass staff | Same convention as alto on their staff |

- Whole rests: traditionally hang **from the fourth line** regardless of voice — in two-voice staves they may be offset vertically.
- Multi-measure rests: a thick horizontal bar with a number above. Applies to one or both voices.
- **Watch for:** rests that appear mid-staff with no note nearby — indicates the other voice is active, and the rest belongs to the silent voice.

### 6.2 Rest Identification Pitfalls for OMR
- A whole rest (looks like an upside-down hat on a line) can be confused with a filled notehead on a ledger line.
- Quarter rests (squiggle symbol) can be confused with ornament markings.
- In two-voice staves, there should theoretically be **two complete metric layers** — if one voice has 3 beats of content, there must be 1 beat of rest somewhere.

---

## 7. Shared-Staff Ambiguities

### 7.1 Deciding Which Note Belongs to Which Voice
When processing a shared staff (short score), follow this priority chain:

1. **Stem direction** → primary signal. Stem up = upper voice, Stem down = lower voice.
2. **Beam direction** → if beamed, the beam follows the stem rule.
3. **Accidental position** → when two simultaneous notes have accidentals, the upper voice's accidental is typically to the right.
4. **Notehead spacing** → two simultaneous notes of different pitches at the same beat: one notehead may be offset horizontally to avoid collision (the lower note shifts right in standard engraving).
5. **Lyric alignment** → the text syllable directly below is for the bottom voice (alto/bass); text between staves or slightly higher may serve the upper voice.

### 7.2 When Voices Cross
**Voice crossing** occurs when a lower voice goes above a higher voice (e.g., alto momentarily higher than soprano). It is valid but unusual. Signs:
- Same-staff notes where stem-down note is higher than stem-up note.
- Crossed stems between notes on the same staff.
- A common compositional device; treat note ownership by **stem direction only**, not by pitch position.

### 7.3 Chord Notation in SATB
When two voices sing notes simultaneously in block chords:
- Both noteheads are stacked vertically with stems going opposite directions.
- The upper voice (soprano/tenor) note is on top; the lower voice (alto/bass) note is below.
- If notes are adjacent (e.g., E4 and F4), the lower note's head shifts to the right of the stem.

---

## 8. Lyrics Placement

| Location | Belongs to Voice |
|----------|-----------------|
| Below treble staff | **Alto** (bottom treble voice) |
| Between treble and bass staves | **Soprano** (when two lyric rows) or shared if all voices have same text |
| Below bass staff | **Bass** (bottom bass voice) |
| Above bass staff / between staves | **Tenor** (when shown) |

### Key Lyric Rules
- **Syllable hyphenation:** Multi-syllable words split with `-` between each syllable. Each syllable aligns with one note.
- **Melisma extender:** A single syllable sung over multiple notes gets an **extender line** (a horizontal line) after the word, extending to the last note.
- **Word underscores vs ties vs slurs:** Do not confuse extender lines with ties/slurs. Extender lines are straight; ties/slurs are curved.
- **Shared text:** If all 4 voices sing the same text in the same rhythm, publishers often print only one lyric line in the middle (between the staves), applying to all parts. This is an optimization, not an error.
- **Verse numbers:** Multiple verses of lyrics may be stacked below a single voice line (Verse 1, Verse 2 etc.) — these are alternate texts for the same melody, not extra voices.

---

## 9. Ties vs Slurs

Both are **curved lines** over/under notes — distinguishing them is critical for pitch/duration accuracy.

| Feature | Tie | Slur |
|---------|-----|------|
| **Purpose** | Extends note duration across a barline or within a measure | Indicates legato (smooth) articulation or melisma |
| **Pitch** | Connects **two notes of the SAME pitch** | Connects **two or more notes of DIFFERENT pitches** (usually) |
| **Effect on duration** | The tied-to note is **not re-articulated**; its duration adds to the first | No duration change; each note is played separately but smoothly |
| **Placement** | Always between two noteheads at the same height | Can span many notes across varying heights |
| **Vocal use** | Sustained vowel held across a barline | Melisma — one syllable sung over many pitches |
| **In processing** | If pitch A4 → A4 curved line, it's a **tie** → merge durations | If C4 → E4 → G4 curved line, it's a **slur** → keep separate notes |

### ⚠️ Edge cases:
- A slur can connect same-pitch notes when the composer wants re-attack with smooth connection — rare but valid.
- Ties can appear within a measure when a dotted rhythm needs bridging across beat boundaries.
- In two-voice staves, a tie for the upper voice curves upward; a tie for the lower voice curves downward.

---

## 10. Beaming Conventions

**Beams** are thick horizontal/diagonal lines connecting eighth notes (and shorter) by their stems.

### 10.1 Modern Choral Beaming (Instrumental-style)
Most modern published SATB scores follow **instrumental beaming** rules:
- Notes are beamed by **metric beat**, regardless of syllable boundaries.
- A 4/4 measure typically beams beats 1, 2, 3, 4 separately.
- The syllable structure is indicated by slurs (melisma markers), NOT by beam breaks.

### 10.2 Traditional Vocal Beaming (Older scores)
- Beams were **broken at each syllable change** — one beam group per syllable.
- This makes it easier to see text underlay but harder to read rhythms.
- Common in Renaissance, Baroque, and early Classical choral scores.

### 10.3 Beam Direction in Two-Voice Staves
- Beams for the upper voice (soprano/tenor) always extend **above** the notes (stems up).
- Beams for the lower voice (alto/bass) always extend **below** the notes (stems down).
- Cross-voice beaming (a single beam group mixing up and down stems) is a **notation error** in SATB short scores — do not occur in properly engraved music.

### 10.4 Beaming Rules to Verify in OMR
- Beams **never cross barlines**.
- In 4/4: beats 1+2 may beam, beats 3+4 may beam, but 2+3 typically do NOT beam (avoids obscuring the midpoint).
- In 3/4: all three beats can beam in a single group.
- In 6/8: two groups of three (beats 1-2-3 and 4-5-6).

---

## 11. Divisi and Voice Splitting

### 11.1 What is Divisi?
**Divisi** (abbreviated `div.`) = the singing section splits into two or more sub-groups, each singing a different pitch simultaneously.

- Most common in: **Soprano div.** (S1 and S2) and **Bass div.** (B1 and B2).
- Notated on the **same staff** using the same stem-direction convention as regular two-voice writing.
- When divisi ends, `unisono` or `unis.` marks the return to one voice.

### 11.2 Example
```
Soprano staff (divisi):
  E5 (stem ↑) = Soprano 1
  C5 (stem ↓) = Soprano 2
```

### 11.3 Extended Divisi
Some complex scores have:
- **SSAATTBB** (double choir) — 8 voice parts
- **SSATBB** — 6 parts
- **SATB divisi** — 4 parts each splitting into 2

These require tracking 2 simultaneous voice layers **per original part** beyond the standard 4 voices.

### 11.4 OMR Challenge
- Divisi looks exactly like regular two-voice writing on a shared staff.
- Distinguishing between "soprano + alto on treble" and "soprano 1 + soprano 2 on treble" requires reading the `div.` textual marking above the staff.
- In practice, pitch range helps: if both stem-up and stem-down notes are clearly in soprano range, it's divisi soprano.

---

## 12. Articulation Marks

Articulation marks modify how individual notes are attacked, sustained, or released.

| Symbol | Name | Placement | Musical Meaning |
|--------|------|-----------|----------------|
| `.` (dot above/below notehead) | Staccato | Above or below notehead | Sing the note short and detached (≈ 50% of its value) |
| `-` (horizontal dash) | Tenuto | Above or below notehead | Hold the note for its full value; slight stress |
| `>` (right-pointing angle) | Accent | Above or below notehead | Strong attack on this note |
| `^` (caret/hat) | Marcato | Above notehead | Very strong, sharp accent |
| `⌒` (curve) | Portato (slurred staccato) | Above/below group | Each note slightly separated but still connected |

### SATB-Specific Placement Rule
- Articulation marks go **above the staff** for the upper voice (soprano/tenor).
- Articulation marks go **below the staff** for the lower voice (alto/bass).
- This keeps them near their respective noteheads in two-voice staves.

---

## 13. Fermata and Breath Marks

### 13.1 Fermata (`𝄐`)
A fermata (half-circle with a dot) placed over a note or rest means **hold longer than written value**:
- Duration is at the conductor's discretion (typically 1.5× to 3× the written value).
- Must appear on **all active staves** simultaneously (all four voice staves show the fermata on the same beat).
- Can appear over a **rest** to indicate a dramatic pause (all voices stop together).
- Two fermatas of different sizes in one measure may indicate different held durations for different voices (rare).

### 13.2 Breath Mark (`,` or `'`)
A small comma or apostrophe placed **above the staff** at the end of a phrase:
- Indicates a collective breath point — the choir breathes here together.
- A `'` (tick mark or **luftpause**) is slightly different: it indicates a slight **lift** in the line (a momentary break in sound) without necessarily requiring a breath.
- Breath marks are not universally printed; conductors often add them.

### 13.3 In OMR Processing
- Fermata symbol can be confused with an accent `^` or a dynamic `p/f` if the score quality is poor.
- Breath marks look like commas — they can be confused with lyric punctuation. Context: breath marks appear **above** the staff; lyric punctuation is **below**.

---

## 14. Rehearsal Marks and Navigation Symbols

### 14.1 Rehearsal Marks
Used to quickly identify positions in the score during rehearsal:
- **Boxed letters**: `[A]`, `[B]`, `[C]` … (most common in contemporary scores).
- **Boxed numbers**: `[1]`, `[2]`, `[3]` … (also common, especially in orchestral-derived works).
- **Measure numbers**: Written above the first measure of each system, or at every 5th/10th/etc. measure.

These appear **above the topmost staff** of the system (or above each individual part in open score).

### 14.2 Navigation Symbols

| Symbol | Meaning |
|--------|---------|
| `D.C.` (Da Capo) | Return to the beginning |
| `D.S.` (Dal Segno) | Return to the `𝄋` (segno) sign |
| `𝄋` (Segno) | "From here" — the target of a Dal Segno |
| `Coda` / `𝄌` | Jump to the Coda section |
| `Fine` | The actual end (used with Da Capo) |
| `||:` … `:|` | Repeat barlines — play the section between them again |
| `1.` / `2.` (volta brackets) | First/second endings on a repeat |

### ⚠️ For OMR processing:
- Repeat barlines look like double barlines with dots — do not mistake thick-thin barlines for repeat starts.
- Volta brackets (1st/2nd endings) span a group of measures and indicate different notes on the repeat — the entire repeated section cannot be blindly duplicated; ending brackets must be handled.

---

## 15. Dynamic Markings in SATB

Dynamics indicate volume. In SATB scores they typically apply to **all voices simultaneously** unless marked on a specific voice's staff.

| Symbol | Italian | Meaning |
|--------|---------|---------|
| `ppp` | pianississimo | Extremely soft |
| `pp` | pianissimo | Very soft |
| `p` | piano | Soft |
| `mp` | mezzo-piano | Moderately soft |
| `mf` | mezzo-forte | Moderately loud |
| `f` | forte | Loud |
| `ff` | fortissimo | Very loud |
| `fff` | fortississimo | Extremely loud |
| `<` (hairpin) | crescendo | Gradually get louder |
| `>` (hairpin) | decrescendo / diminuendo | Gradually get softer |
| `sfz` / `sf` | sforzando | Sudden strong accent |
| `fp` | forte-piano | Loud, then immediately soft |

- Placed **below** the relevant staff (below bass staff for whole-group dynamics, below each staff for individual part dynamics).
- A dynamic on only the soprano staff may indicate a solo or subdivision.

---

## 16. MusicXML Voice Encoding

Understanding MusicXML encoding is essential for programmatic SATB processing.

### 16.1 Part vs Voice Encoding
MusicXML uses two hierarchical concepts:

```xml
<part id="P1">  <!-- One part = one instrument/voice group -->
  <measure number="1">
    <note>
      <voice>1</voice>   <!-- Voice 1 = upper (Soprano or Tenor) -->
      <staff>1</staff>   <!-- Staff 1 = treble or top -->
    </note>
    <note>
      <voice>2</voice>   <!-- Voice 2 = lower (Alto or Bass) -->
      <staff>1</staff>   <!-- Same staff, different voice -->
    </note>
  </measure>
</part>
```

### 16.2 Common MusicXML SATB Encodings

**Short Score (2 parts):**
```
Part 1 (treble): Voice 1 = Soprano, Voice 2 = Alto
Part 2 (bass):  Voice 1 = Tenor,   Voice 2 = Bass
```

**Open Score (4 parts):**
```
Part 1: Voice 1 = Soprano
Part 2: Voice 1 = Alto
Part 3: Voice 1 = Tenor
Part 4: Voice 1 = Bass
```

**Mixed encoding (2 staves per part):**
```
Part 1: Staff 1 (treble) Soprano, Staff 2 (bass) Alto
Part 2: Staff 1 (treble) Tenor,   Staff 2 (bass) Bass
```

### 16.3 Voice Ambiguity in MusicXML
- The `<voice>` element is NOT standardized in semantics — different software uses `1/2` or `1/2/3/4` differently.
- **Sibelius**: voice 1 = upper, voice 2 = lower (per staff).
- **Finale**: voice 1/2 per layer.
- **MuseScore**: voice 1 = stem up, voice 2 = stem down.
- Always also check `<stem>` direction: `<stem>up</stem>` or `<stem>down</stem>` for ground truth.

### 16.4 Tenor Octave in MusicXML
- Look for `<transpose><octave-change>-1</octave-change></transpose>` in the tenor part's `<attributes>`.
- Or check for the clef sign: `<clef><sign>G</sign><line>2</line><clef-octave-change>-1</clef-octave-change></clef>`.
- If this is present, all tenor pitches must be shifted down one octave when rendering to audio/MIDI.

---

## 17. OMR Processing Challenges

### 17.1 Specific SATB Challenges

| Challenge | Description | Mitigation Strategy |
|-----------|-------------|---------------------|
| **Two voices per staff** | Stem direction is the only differentiator; OCR must detect stem direction accurately | Prioritize stem endpoint detection; never assign notes solely by pitch height |
| **Tenor clef ambiguity** | Octave treble clef `8` is small and may be missed | Always check for `8` marker below treble clef on all staves |
| **Voice crossing** | When alto goes above soprano; standard pitch-range heuristics fail | Never use pitch position alone; trust stem direction |
| **Lyric interference** | Text under the staff can confuse staff-line detection | Use staff-line detection that excludes text zones |
| **Shared noteheads (unison)** | One notehead with two stems can be misread as one note | If a notehead has two stems, create two voice events for that beat |
| **Divisi misidentification** | Two soprano voices look like soprano + alto | Check pitch ranges: if both voices are in soprano range, it's divisi |
| **Dense chords** | Close-interval chords with offset noteheads look like single notes | Check for horizontally offset noteheads at the same vertical position |
| **Beams across voices** | Misidentified beams connecting up-stem and down-stem notes | Flag any beam connecting notes with mixed stem directions as an error |
| **Slur vs tie confusion** | Same appearance but different semantics | Check if connected notes have the same pitch (tie) or different (slur) |
| **Multi-measure rests** | Thick bar with number — easy to miss | Look for the "thick beam on middle line with a number" pattern |

### 17.2 Score Quality Issues
- **Photocopied scores**: Degraded lines, broken staff lines, smudged noteheads.
- **Hand-written scores**: Non-standard symbol shapes, irregular spacing.
- **Old printed scores**: Different engraving styles, older clef symbols, figured bass.
- **Scan resolution**: Below 300 DPI causes symbol merging and loss of small features (the `8` in tenor clef, staccato dots).

### 17.3 Recommended Processing Order for SATB PDFs

1. **Staff detection** — find all horizontal staff lines and group into systems
2. **System/brace detection** — identify which staves are grouped (SA together, TB together)
3. **Clef detection** — identify treble/bass/8vb treble on each staff
4. **Key & time signature** — parse at the start of each system and at changes
5. **Voice separation** — detect stem direction per notehead to assign to Voice 1/Voice 2
6. **Pitch reading** — convert staff-position + clef + key signature to MIDI pitch
7. **Tenor correction** — if 8vb treble clef, subtract 12 semitones from all tenor MIDI values
8. **Duration reading** — notehead type + dots + beams + ties = duration
9. **Lyric alignment** — map text syllables to notes per voice
10. **Barline/repeat structure** — parse navigation symbols last

---

## 18. Voice Validation Rules

After extraction, validate each voice line using these music theory rules:

### 18.1 Pitch Range Validation

```python
VALID_RANGES = {
    'soprano': (60, 84),   # C4 to C6 (MIDI)
    'alto':    (52, 74),   # E3 to D5 (MIDI)
    'tenor':   (48, 69),   # C3 to A4 sounding (MIDI)
    'bass':    (40, 62),   # E2 to D4 (MIDI)
}
COMFORTABLE_RANGES = {
    'soprano': (64, 79),   # E4 to G5
    'alto':    (59, 71),   # B3 to B4
    'tenor':   (52, 64),   # E3 to E4
    'bass':    (43, 56),   # G2 to G#3
}
```

Flag notes outside valid ranges as likely OCR errors.

### 18.2 Voice Leading Rules
These rules, when violated, may indicate a misread:
- **No parallel perfect fifths** between any two voices (a strong signal of likely OMR error if found).
- **No parallel perfect octaves** between any two adjacent voices.
- **Soprano and Bass should not exceed a 2-octave span** in most traditional choral writing.
- **No voice should leap more than a 10th** without returning stepwise (leaps larger than this are suspicious).

### 18.3 Metric Completeness
Each voice in each measure must account for exactly the number of beats specified by the time signature:
- Sum of all note durations + rest durations in a measure, per voice, must equal the measure's total duration.
- If a voice's measure appears incomplete, a rest may have been missed by OMR.

### 18.4 Unison Check
When two voices on a staff share the same pitch at the same beat:
- The note should appear in both extracted voice streams.
- OMR systems sometimes extract only one note for a shared notehead with two stems.

---

## 19. Quick Reference Cheat Sheet

```
┌─────────────────────────────────────────────────────────────────┐
│                    SATB AT A GLANCE                             │
├──────────┬──────────┬──────────┬──────────┬────────────────────┤
│ Voice    │ Clef     │ Stem     │ Sounding  │ Range (MIDI)       │
├──────────┼──────────┼──────────┼──────────┼────────────────────┤
│ Soprano  │ Treble   │ UP ↑     │ At pitch  │ C4–A5 (60–81)      │
│ Alto     │ Treble   │ DOWN ↓   │ At pitch  │ G3–D5 (55–74)      │
│ Tenor    │ 8vb Treb │ UP ↑     │ -8va  ⚠️  │ C3–G4 (48–67)      │
│ Bass     │ Bass     │ DOWN ↓   │ At pitch  │ E2–C4 (40–60)      │
└──────────┴──────────┴──────────┴──────────┴────────────────────┘

KEY RULES:
  1. Stem direction = voice identity in short score (ALWAYS)
  2. Tenor sounds one octave LOWER than written (8vb clef)
  3. Tie = same pitch, merge duration | Slur = smooth articulation
  4. div. = voice splits; unis. = voice rejoins
  5. Breath mark (,) above staff ≠ lyric comma below staff
  6. Fermata over rest = all voices pause together
  7. Lyric extender line (straight) ≠ tie/slur (curved)
  8. MusicXML <voice>1</voice> = stem-up voice; 2 = stem-down
```

---

## References & Further Reading
- *The Study of Counterpoint* (Fux) — historical SATB voice-leading rules
- *Choral Conducting* (Decker & Kirk) — practical SATB score reading
- Grove Music Online — "Score" and "SATB" entries
- MusicXML 4.0 Specification — W3C / MakeMusic
- *Optical Music Recognition: State of the Art* — Calvo-Zaragoza et al. (2020)
- MuseScore 4 Documentation — Voice notation conventions
