import { useEffect, useRef, useState } from "react";
import * as Tone from "tone";
import { Midi } from "@tonejs/midi";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Card } from "@/components/ui/card";
import {
  Play,
  Pause,
  Square,
  Volume2,
  VolumeX,
  Loader2,
  AlertCircle,
  Download,
  Repeat,
  ChevronUp,
  ChevronDown,
} from "lucide-react";
import { getVoiceColors } from "@/lib/voiceColors";
import {
  VOICE_INSTRUMENTS,
  loadSoundfontInstrument,
  playSynthNote,
  setSynthVolume,
  stopSynth,
  disposeSynth,
  type VoiceSynth,
} from "@/lib/soundfontPlayer";
import { usePublishPlayback } from "@/hooks/usePlaybackSync";

interface VoiceControl {
  voice: string;
  label: string;
  muted: boolean;
  volume: number;
}

interface MidiPlayerProps {
  midiUrls: Record<string, string>; // { soprano: url, alto: url, ... }
  availableVoices: string[];
  sheetTitle?: string;
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9\-_ ]/g, "").trim().replace(/\s+/g, "-") || "sheet";
}

const SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5] as const;
type Speed = (typeof SPEED_OPTIONS)[number];

// F-13: moved to module scope — recreating this object on every render is wasteful
const voiceLabels: Record<string, string> = {
  soprano: "Soprano",
  alto: "Alto",
  tenor: "Tenor",
  bass: "Bass",
  all: "All Voices",
};

/**
 * Calculate measure start times (in seconds, adjusted for speed) from MIDI header data.
 * Uses the header's built-in ticksToSeconds for accurate tempo-aware conversion.
 */
function calcMeasureStartTimes(midi: Midi, speedFactor: number): number[] {
  const ppq = midi.header.ppq;
  const totalTicks = midi.durationTicks;

  // timeSignatures: Array<{ ticks: number; timeSignature: [numerator, denominator] }>
  const timeSigs = [...midi.header.timeSignatures].sort((a, b) => a.ticks - b.ticks);
  if (timeSigs.length === 0) timeSigs.push({ ticks: 0, timeSignature: [4, 4] });

  const measureStarts: number[] = [];
  let currentTick = 0;
  let timeSigIdx = 0;

  while (currentTick <= totalTicks + 1) {
    // Advance to the active time signature
    while (
      timeSigIdx + 1 < timeSigs.length &&
      timeSigs[timeSigIdx + 1].ticks <= currentTick
    ) {
      timeSigIdx++;
    }
    const [num, denom] = timeSigs[timeSigIdx].timeSignature;

    // header.ticksToSeconds already handles all tempo changes
    measureStarts.push(midi.header.ticksToSeconds(currentTick) / speedFactor);

    const ticksPerMeasure = Math.round((ppq * 4 * num) / denom);
    if (ticksPerMeasure <= 0) break; // safety guard against malformed data
    currentTick += ticksPerMeasure;
  }

  return measureStarts;
}

export default function MidiPlayer({ midiUrls, availableVoices, sheetTitle }: MidiPlayerProps) {
  const publishPlayback = usePublishPlayback();

  // ── Playback state ───────────────────────────────────────────────────────────
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [voiceControls, setVoiceControls] = useState<VoiceControl[]>([]);
  const [soloVoice, setSoloVoice] = useState<string | null>(null);
  const [speed, setSpeed] = useState<Speed>(1);
  const [isLoading, setIsLoading] = useState(true);
  const [loadingMessage, setLoadingMessage] = useState("Loading MIDI player...");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [failedVoices, setFailedVoices] = useState<string[]>([]);

  // ── Transpose state ──────────────────────────────────────────────────────────
  const [transpose, setTranspose] = useState(0);

  // ── Loop state ───────────────────────────────────────────────────────────────
  const [loopEnabled, setLoopEnabled] = useState(false);
  const [loopStartMeasure, setLoopStartMeasure] = useState(1);
  const [loopEndMeasure, setLoopEndMeasure] = useState(4);
  const [totalMeasures, setTotalMeasures] = useState(8);
  // Derived seconds — kept in state for rendering the visual indicator
  const [loopStartSeconds, setLoopStartSeconds] = useState(0);
  const [loopEndSeconds, setLoopEndSeconds] = useState(0);

  // ── Core playback refs ───────────────────────────────────────────────────────
  const isPlayingRef = useRef(false);
  const speedRef = useRef<Speed>(1);
  const soloVoiceRef = useRef<string | null>(null);
  const synthsRef = useRef<Map<string, VoiceSynth>>(new Map());
  const partsRef = useRef<Map<string, Tone.Part>>(new Map());
  const midiDataRef = useRef<Map<string, Midi>>(new Map());
  const progressIntervalRef = useRef<NodeJS.Timeout | null>(null);
  // Track whether we're resuming from a pause (true) vs starting fresh (false).
  const isPausedRef = useRef(false);

  // ── Feature refs (readable inside intervals without stale closures) ──────────
  const transposeRef = useRef(0);
  const loopEnabledRef = useRef(false);
  const loopStartSecondsRef = useRef(0);
  const loopEndSecondsRef = useRef(0);
  const measureStartTimesRef = useRef<number[]>([]);
  // Mirror of duration state for use in async handlers
  const durationRef = useRef(0);

  // ── Sync refs with state ─────────────────────────────────────────────────────
  useEffect(() => { isPlayingRef.current = isPlaying; }, [isPlaying]);
  useEffect(() => { soloVoiceRef.current = soloVoice; }, [soloVoice]);
  useEffect(() => { loopEnabledRef.current = loopEnabled; }, [loopEnabled]);

  // Initialize voice controls
  useEffect(() => {
    const controls: VoiceControl[] = availableVoices.map(voice => ({
      voice,
      label: voiceLabels[voice] || voice,
      muted: false,
      volume: 0.7,
    }));
    setVoiceControls(controls);
  }, [availableVoices]);

  // Recompute loop boundary seconds whenever the measure selections or measure
  // timing data changes (totalMeasures / duration act as proxies for the latter).
  useEffect(() => {
    const times = measureStartTimesRef.current;
    if (times.length === 0) return;
    const startSec = times[loopStartMeasure - 1] ?? 0;
    // End of loopEndMeasure = start of the *next* measure (or song end)
    const endSec = times[loopEndMeasure] ?? durationRef.current;
    loopStartSecondsRef.current = startSec;
    loopEndSecondsRef.current = endSec;
    setLoopStartSeconds(startSec);
    setLoopEndSeconds(endSec);
  }, [loopStartMeasure, loopEndMeasure, totalMeasures, duration]);

  // ── buildParts ───────────────────────────────────────────────────────────────
  /**
   * Rebuild Tone.Parts from already-loaded MIDI data.
   * @param speedFactor  Playback speed multiplier (0.5 – 1.5).
   * @param transposeOffset  Semitone shift applied to every note (-12 to +12).
   */
  const buildParts = (speedFactor: number, transposeOffset: number = 0) => {
    // Dispose old parts
    partsRef.current.forEach(part => { try { part.dispose(); } catch (_) {} });
    partsRef.current.clear();

    let maxDuration = 0;
    let computedMeasureTimes: number[] = [];

    midiDataRef.current.forEach((midi, voice) => {
      const rawDuration = midi.duration;
      const scaledDuration = rawDuration / speedFactor;
      if (scaledDuration > maxDuration) {
        maxDuration = scaledDuration;
        computedMeasureTimes = calcMeasureStartTimes(midi, speedFactor);
      }

      const notes: Array<{
        time: number;
        note: string;
        duration: number;
        velocity: number;
      }> = [];

      midi.tracks.forEach(track => {
        track.notes.forEach(note => {
          // Transpose via Tone.js frequency utilities: shift, then convert back to note name
          const noteName =
            transposeOffset !== 0
              ? Tone.Frequency(note.name).transpose(transposeOffset).toNote()
              : note.name;

          notes.push({
            time: note.time / speedFactor,
            note: noteName,
            duration: note.duration / speedFactor,
            velocity: note.velocity, // 0-1 from @tonejs/midi
          });
        });
      });

      console.log(
        `[MidiPlayer] Building part "${voice}": ${notes.length} notes, ` +
        `duration: ${scaledDuration.toFixed(2)}s, transpose: ${transposeOffset > 0 ? "+" : ""}${transposeOffset}`
      );

      const part = new Tone.Part<{
        time: number;
        note: string;
        duration: number;
        velocity: number;
      }>(
        (time, n) => {
          const synth = synthsRef.current.get(voice);
          if (!synth) {
            console.warn(`[MidiPlayer] No synth found for voice "${voice}" at time ${time}`);
            return;
          }
          playSynthNote(synth, n.note, n.duration, time, n.velocity);
        },
        notes,
      );

      part.loop = false;
      partsRef.current.set(voice, part);
    });

    setDuration(maxDuration);
    durationRef.current = maxDuration;

    // Persist measure timing data for loop calculations
    measureStartTimesRef.current = computedMeasureTimes;
    setTotalMeasures(computedMeasureTimes.length);

    console.log(
      `[MidiPlayer] buildParts complete: ${partsRef.current.size} parts, ` +
      `maxDuration: ${maxDuration.toFixed(2)}s, measures: ${computedMeasureTimes.length}`
    );
  };

  // ── Load MIDI files ──────────────────────────────────────────────────────────
  // F-04: use AbortController to cancel in-flight fetches when deps change.
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;

    const pendingSynths = new Map<string, VoiceSynth>();

    const loadMidiFiles = async () => {
      setIsLoading(true);
      setLoadError(null);
      setLoadingMessage("Loading MIDI files...");

      const pendingMidi = new Map<string, Midi>();
      const failed: string[] = [];

      // Step 1: Fetch all MIDI files
      for (const voice of availableVoices) {
        if (voice === "all") continue;
        if (signal.aborted) break;

        try {
          const url = midiUrls[voice];
          if (!url) { failed.push(voice); continue; }

          const response = await fetch(url, { signal });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const arrayBuffer = await response.arrayBuffer();

          if (signal.aborted) break;
          pendingMidi.set(voice, new Midi(arrayBuffer));
        } catch (error) {
          if ((error as Error).name === "AbortError" || signal.aborted) break;
          console.error(`Failed to load MIDI for voice "${voice}":`, error);
          failed.push(voice);
        }
      }

      if (signal.aborted) return;

      // Step 2: Load SoundFont instruments
      const audioContext = Tone.getContext().rawContext as AudioContext;
      const voicesToLoad = availableVoices.filter(v => v !== "all" && !failed.includes(v));
      setLoadingMessage(`Loading choir sounds (${voicesToLoad.length} voice${voicesToLoad.length > 1 ? "s" : ""})...`);

      for (const voice of voicesToLoad) {
        if (signal.aborted) break;
        const instrName = VOICE_INSTRUMENTS[voice] || "choir_aahs";
        try {
          const soundfont = await loadSoundfontInstrument(audioContext, instrName);
          pendingSynths.set(voice, { type: "soundfont", instrument: soundfont });
          console.log(`[MidiPlayer] Loaded SoundFont for voice "${voice}" (${instrName})`);
        } catch (err) {
          if (signal.aborted) break;
          console.warn(`[MidiPlayer] SoundFont load failed for voice "${voice}" (${instrName}), falling back to PolySynth:`, err);
          const fallback = new Tone.PolySynth(Tone.Synth, {
            oscillator: { type: "sine" },
            envelope: { attack: 0.005, decay: 0.1, sustain: 0.3, release: 0.5 },
          }).toDestination();
          fallback.volume.value = -10;
          pendingSynths.set(voice, { type: "polySynth", synth: fallback });
        }
      }

      if (signal.aborted) return;

      // Commit: transfer from pending collections into the stable refs
      pendingMidi.forEach((midi, voice) => midiDataRef.current.set(voice, midi));
      pendingSynths.forEach((synth, voice) => synthsRef.current.set(voice, synth));
      pendingSynths.clear();

      console.log(`[MidiPlayer] Loaded MIDI for voices: ${Array.from(midiDataRef.current.keys()).join(", ")}`);
      if (failed.length > 0) console.warn(`[MidiPlayer] Failed to load voices: ${failed.join(", ")}`);

      setFailedVoices(failed);

      if (failed.length === availableVoices.filter(v => v !== "all").length) {
        setLoadError("Failed to load MIDI files. Please refresh the page and try again.");
      }

      buildParts(speedRef.current, transposeRef.current);
      console.log(`[MidiPlayer] Built ${partsRef.current.size} playable parts`);
      setIsLoading(false);
    };

    if (Object.keys(midiUrls).length > 0) {
      loadMidiFiles();
    }

    return () => {
      controller.abort();
      stopPlayback();
      pendingSynths.forEach(s => disposeSynth(s));
      synthsRef.current.forEach(s => disposeSynth(s));
      partsRef.current.forEach(p => { try { p.dispose(); } catch (_) {} });
      synthsRef.current.clear();
      partsRef.current.clear();
      midiDataRef.current.clear();
      if (progressIntervalRef.current) {
        clearInterval(progressIntervalRef.current);
        progressIntervalRef.current = null;
      }
    };
  }, [midiUrls, availableVoices]);

  // Rebuild parts when speed changes (MIDI data already loaded)
  useEffect(() => {
    speedRef.current = speed;
    if (midiDataRef.current.size === 0) return;
    stopPlayback();
    buildParts(speed, transposeRef.current);
  }, [speed]);

  // ── Playback engine ──────────────────────────────────────────────────────────

  /** Start or resume playback. Captures duration snapshot for the interval. */
  const startPlayback = async () => {
    console.log("[MidiPlayer] Starting playback...");

    await Tone.start();

    if (!isPausedRef.current) {
      Tone.getTransport().cancel(0);
      Tone.getTransport().seconds = 0;
      partsRef.current.forEach((part, voice) => {
        console.log(`[MidiPlayer] Starting part: ${voice}`);
        part.start(0);
      });
    }

    isPausedRef.current = false;
    Tone.getTransport().start();
    setIsPlaying(true);
    console.log("[MidiPlayer] Transport started, playback commenced");

    // Snapshot current duration for the interval closure (avoids stale-closure issues
    // if duration state is mutated mid-playback, which only happens on rebuild anyway).
    const dur = durationRef.current;

    progressIntervalRef.current = setInterval(() => {
      const currentTime = Tone.getTransport().seconds;
      setProgress(currentTime);
      publishPlayback(currentTime, true, dur);

      // Loop check — runs every 100 ms
      if (
        loopEnabledRef.current &&
        loopEndSecondsRef.current > 0 &&
        currentTime >= loopEndSecondsRef.current
      ) {
        Tone.getTransport().seconds = loopStartSecondsRef.current;
        return; // skip the end-of-song check this tick
      }

      if (currentTime >= dur) {
        stopPlayback();
      }
    }, 100);
  };

  const pausePlayback = () => {
    Tone.getTransport().pause();
    isPausedRef.current = true;
    setIsPlaying(false);
    publishPlayback(Tone.getTransport().seconds, false);

    synthsRef.current.forEach(synth => {
      if (synth.type === "soundfont") synth.instrument.stop();
    });

    if (progressIntervalRef.current) {
      clearInterval(progressIntervalRef.current);
      progressIntervalRef.current = null;
    }
  };

  const stopPlayback = () => {
    Tone.getTransport().stop();
    Tone.getTransport().seconds = 0;
    isPausedRef.current = false;
    setIsPlaying(false);
    setProgress(0);
    publishPlayback(0, false);

    if (progressIntervalRef.current) {
      clearInterval(progressIntervalRef.current);
      progressIntervalRef.current = null;
    }

    partsRef.current.forEach(part => { part.stop(); });
    synthsRef.current.forEach(synth => stopSynth(synth));
  };

  // ── Transpose handler ────────────────────────────────────────────────────────
  /**
   * Change the transpose offset by `delta` semitones.
   * If playing, pauses → rebuilds parts → resumes from the same position.
   */
  const handleTransposeChange = (delta: number) => {
    const newTranspose = Math.max(-12, Math.min(12, transposeRef.current + delta));
    if (newTranspose === transposeRef.current) return;

    const wasPlaying = isPlayingRef.current;
    const currentPos = Tone.getTransport().seconds;

    // Soft-pause: halt transport + clear interval but keep position
    if (wasPlaying) {
      Tone.getTransport().pause();
      setIsPlaying(false);
      isPlayingRef.current = false;
      if (progressIntervalRef.current) {
        clearInterval(progressIntervalRef.current);
        progressIntervalRef.current = null;
      }
      synthsRef.current.forEach(synth => {
        if (synth.type === "soundfont") synth.instrument.stop();
      });
    }

    // Tear down current Parts (required before rebuilding with new pitch)
    partsRef.current.forEach(part => { try { part.stop(); } catch (_) {} });
    Tone.getTransport().cancel(0);

    // Commit new transpose value
    transposeRef.current = newTranspose;
    setTranspose(newTranspose);

    // Rebuild with new pitch
    buildParts(speedRef.current, newTranspose);

    if (wasPlaying || isPausedRef.current) {
      // Re-schedule all new parts from Transport time 0, then seek to saved position
      partsRef.current.forEach(part => part.start(0));
      Tone.getTransport().seconds = currentPos;

      if (wasPlaying) {
        Tone.getTransport().start();
        setIsPlaying(true);
        isPlayingRef.current = true;
        isPausedRef.current = false;

        const dur = durationRef.current;
        progressIntervalRef.current = setInterval(() => {
          const ct = Tone.getTransport().seconds;
          setProgress(ct);
          publishPlayback(ct, true, dur);

          if (
            loopEnabledRef.current &&
            loopEndSecondsRef.current > 0 &&
            ct >= loopEndSecondsRef.current
          ) {
            Tone.getTransport().seconds = loopStartSecondsRef.current;
            return;
          }

          if (ct >= dur) stopPlayback();
        }, 100);
      } else {
        // Was paused: remain paused at the same position
        isPausedRef.current = true;
        setProgress(currentPos);
      }
    }
  };

  // ── Keyboard shortcuts ───────────────────────────────────────────────────────
  useEffect(() => { isPlayingRef.current = isPlaying; }, [isPlaying]);
  useEffect(() => { soloVoiceRef.current = soloVoice; }, [soloVoice]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      if (e.key === " ") {
        e.preventDefault();
        if (isPlayingRef.current) pausePlayback(); else startPlayback();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        const next = Math.min(Tone.getTransport().seconds + 5, duration);
        Tone.getTransport().seconds = next;
        setProgress(next);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        const prev = Math.max(Tone.getTransport().seconds - 5, 0);
        Tone.getTransport().seconds = prev;
        setProgress(prev);
      } else if (e.key === "m" || e.key === "M") {
        setVoiceControls(prev => {
          if (prev.length === 0) return prev;
          const target = prev[0];
          const updated = prev.map((vc, i) => i === 0 ? { ...vc, muted: !vc.muted } : vc);
          const synth = synthsRef.current.get(target.voice);
          if (synth) {
            const newMuted = !target.muted;
            const effectiveMuted = newMuted || (soloVoiceRef.current !== null && soloVoiceRef.current !== target.voice);
            setSynthVolume(synth, target.volume, effectiveMuted);
          }
          return updated;
        });
      } else if (e.key >= "1" && e.key <= "9") {
        const idx = parseInt(e.key, 10) - 1;
        setVoiceControls(prev => {
          if (idx >= prev.length) return prev;
          const target = prev[idx];
          const updated = prev.map((vc, i) => i === idx ? { ...vc, muted: !vc.muted } : vc);
          const synth = synthsRef.current.get(target.voice);
          if (synth) {
            const newMuted = !target.muted;
            const effectiveMuted = newMuted || (soloVoiceRef.current !== null && soloVoiceRef.current !== target.voice);
            setSynthVolume(synth, target.volume, effectiveMuted);
          }
          return updated;
        });
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [duration]);

  // ── UI handlers ──────────────────────────────────────────────────────────────

  const handlePlayPause = () => {
    if (isPlaying) pausePlayback(); else startPlayback();
  };

  const handleStop = () => { stopPlayback(); };

  const handleProgressChange = (value: number[]) => {
    const newTime = value[0];
    Tone.getTransport().seconds = newTime;
    setProgress(newTime);
  };

  const applyVolume = (vc: VoiceControl, currentSolo: string | null) => {
    const synth = synthsRef.current.get(vc.voice);
    if (!synth) return;
    const effectiveMuted = vc.muted || (currentSolo !== null && currentSolo !== vc.voice);
    setSynthVolume(synth, vc.volume, effectiveMuted);
  };

  const handleSolo = (voice: string) => {
    setSoloVoice(prev => {
      const next = prev === voice ? null : voice;
      voiceControls.forEach(vc => applyVolume(vc, next));
      return next;
    });
  };

  const toggleMute = (voice: string) => {
    setVoiceControls(prev => {
      const newVoiceControls = prev.map(vc =>
        vc.voice === voice ? { ...vc, muted: !vc.muted } : vc
      );
      const updatedControl = newVoiceControls.find(vc => vc.voice === voice);
      if (updatedControl) applyVolume(updatedControl, soloVoice);
      return newVoiceControls;
    });
  };

  const handleVolumeChange = (voice: string, value: number[]) => {
    const newVolume = value[0];
    setVoiceControls(prev => {
      const newVoiceControls = prev.map(vc =>
        vc.voice === voice ? { ...vc, volume: newVolume } : vc
      );
      const updatedControl = newVoiceControls.find(vc => vc.voice === voice);
      if (updatedControl) applyVolume(updatedControl, soloVoice);
      return newVoiceControls;
    });
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  // ── Loop measure helpers ─────────────────────────────────────────────────────

  const handleLoopStartChange = (value: string) => {
    const n = parseInt(value, 10);
    if (isNaN(n)) return;
    const clamped = Math.max(1, Math.min(n, loopEndMeasure - 1));
    setLoopStartMeasure(clamped);
  };

  const handleLoopEndChange = (value: string) => {
    const n = parseInt(value, 10);
    if (isNaN(n)) return;
    const clamped = Math.max(loopStartMeasure + 1, Math.min(n, Math.max(totalMeasures, 1)));
    setLoopEndMeasure(clamped);
  };

  // ── Early-return states ──────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <Card className="p-6 dark:bg-gray-800 dark:border-gray-700">
        <div className="text-center" role="status" aria-live="polite">
          <Loader2 className="h-8 w-8 animate-spin mx-auto mb-2 text-blue-500 dark:text-blue-400" />
          <p className="text-sm text-gray-600 dark:text-gray-300">{loadingMessage}</p>
          <span className="sr-only">Loading musical playback controls</span>
        </div>
      </Card>
    );
  }

  if (loadError) {
    return (
      <Card className="p-6 bg-red-50 border-red-200 dark:bg-red-900/20 dark:border-red-800">
        <div className="flex items-center gap-3 text-red-700 dark:text-red-400">
          <AlertCircle className="h-5 w-5 flex-shrink-0" />
          <p className="text-sm">{loadError}</p>
        </div>
      </Card>
    );
  }

  // Percentages for the loop region overlay on the progress slider
  const loopStartPct = duration > 0 ? (loopStartSeconds / duration) * 100 : 0;
  const loopEndPct = duration > 0 ? (loopEndSeconds / duration) * 100 : 0;

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <Card className="p-6 space-y-6 dark:bg-gray-800 dark:border-gray-700">
      {/* Partial load warning */}
      {failedVoices.length > 0 && !loadError && (
        <div className="flex items-center gap-3 p-3 bg-yellow-50 border border-yellow-200 rounded-lg text-yellow-800 dark:bg-yellow-900/20 dark:border-yellow-800 dark:text-yellow-400">
          <AlertCircle className="h-4 w-4 flex-shrink-0" />
          <p className="text-sm">
            Could not load: {failedVoices.join(", ")}. Other voices are still playable.
          </p>
        </div>
      )}

      {/* Playback Controls */}
      <div className="space-y-4">
        <div className="flex items-center gap-4">
          <Button
            onClick={handlePlayPause}
            variant="default"
            size="lg"
            className="w-24 dark:bg-blue-600 dark:hover:bg-blue-700"
          >
            {isPlaying ? (
              <>
                <Pause className="mr-2 h-4 w-4" />
                Pause
              </>
            ) : (
              <>
                <Play className="mr-2 h-4 w-4" />
                Play
              </>
            )}
          </Button>

          <Button
            onClick={handleStop}
            variant="outline"
            size="lg"
            className="dark:border-gray-600 dark:text-white"
          >
            <Square className="mr-2 h-4 w-4" />
            Stop
          </Button>

          <div className="flex-1 text-sm text-muted-foreground dark:text-gray-300">
            {formatTime(progress)} / {formatTime(duration)}
          </div>
        </div>

        {/* Progress Bar with optional loop region overlay */}
        <div className="space-y-1">
          <div className="relative">
            {/* Loop region visual indicator */}
            {loopEnabled && duration > 0 && (
              <div
                aria-hidden="true"
                className="absolute top-1/2 -translate-y-1/2 h-2 pointer-events-none rounded-full bg-blue-400/35 border border-blue-400/60"
                style={{
                  left: `${loopStartPct}%`,
                  width: `${Math.max(0, loopEndPct - loopStartPct)}%`,
                }}
              />
            )}
            <Slider
              value={[progress]}
              max={duration}
              step={0.1}
              onValueChange={handleProgressChange}
              className="w-full"
              aria-label="Playback progress"
              aria-valuetext={`${formatTime(progress)} of ${formatTime(duration)}`}
            />
          </div>
        </div>

        {/* Speed Control */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground dark:text-gray-400 mr-1">Speed:</span>
          {SPEED_OPTIONS.map(s => (
            <Button
              key={s}
              variant={speed === s ? "default" : "outline"}
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => setSpeed(s)}
              aria-pressed={speed === s}
            >
              {s}×
            </Button>
          ))}
        </div>

        {/* Loop & Transpose Row */}
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          {/* ── Loop Controls ─────────────────────────────────────────────── */}
          <div className="flex items-center gap-2 flex-wrap">
            {/* Toggle button */}
            <Button
              variant={loopEnabled ? "default" : "outline"}
              size="sm"
              className={`h-7 px-2 gap-1.5 text-xs ${loopEnabled ? "bg-blue-600 hover:bg-blue-700 dark:bg-blue-600 dark:hover:bg-blue-700" : "dark:border-gray-600 dark:text-white"}`}
              onClick={() => setLoopEnabled(prev => !prev)}
              aria-pressed={loopEnabled}
              aria-label={loopEnabled ? "Disable loop" : "Enable loop"}
            >
              <Repeat className="h-3 w-3" />
              Loop
            </Button>

            {/* Measure range inputs — always visible so user can configure before enabling */}
            <span className="text-xs text-muted-foreground dark:text-gray-400">From</span>
            <input
              type="number"
              min={1}
              max={Math.max(1, loopEndMeasure - 1)}
              value={loopStartMeasure}
              onChange={e => handleLoopStartChange(e.target.value)}
              disabled={!loopEnabled}
              className={`w-14 h-7 rounded border text-xs text-center bg-transparent dark:text-white dark:border-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500 ${loopEnabled ? "border-gray-300" : "border-gray-200 opacity-50 dark:border-gray-700"}`}
              aria-label="Loop start measure"
            />
            <span className="text-xs text-muted-foreground dark:text-gray-400">to</span>
            <input
              type="number"
              min={loopStartMeasure + 1}
              max={Math.max(loopStartMeasure + 1, totalMeasures)}
              value={loopEndMeasure}
              onChange={e => handleLoopEndChange(e.target.value)}
              disabled={!loopEnabled}
              className={`w-14 h-7 rounded border text-xs text-center bg-transparent dark:text-white dark:border-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500 ${loopEnabled ? "border-gray-300" : "border-gray-200 opacity-50 dark:border-gray-700"}`}
              aria-label="Loop end measure"
            />
            {totalMeasures > 0 && (
              <span className="text-[10px] text-muted-foreground/60 dark:text-gray-500">
                / {totalMeasures}
              </span>
            )}
          </div>

          {/* ── Transpose Controls ────────────────────────────────────────── */}
          <div className="flex items-center gap-2 ml-auto">
            <span className="text-xs text-muted-foreground dark:text-gray-400">Transpose:</span>

            <Button
              variant="outline"
              size="sm"
              className="h-7 w-7 p-0 dark:border-gray-600 dark:text-white"
              onClick={() => handleTransposeChange(-1)}
              disabled={transpose <= -12}
              aria-label="Transpose down one semitone"
            >
              <ChevronDown className="h-3.5 w-3.5" />
            </Button>

            <span
              className={`w-8 text-center text-sm font-mono font-medium tabular-nums ${
                transpose === 0
                  ? "text-muted-foreground dark:text-gray-400"
                  : transpose > 0
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-rose-600 dark:text-rose-400"
              }`}
              aria-live="polite"
              aria-label={`Current transpose: ${transpose > 0 ? "+" : ""}${transpose} semitones`}
            >
              {transpose > 0 ? `+${transpose}` : transpose}
            </span>

            <Button
              variant="outline"
              size="sm"
              className="h-7 w-7 p-0 dark:border-gray-600 dark:text-white"
              onClick={() => handleTransposeChange(1)}
              disabled={transpose >= 12}
              aria-label="Transpose up one semitone"
            >
              <ChevronUp className="h-3.5 w-3.5" />
            </Button>

            {transpose !== 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-1.5 text-xs text-muted-foreground dark:text-gray-400"
                onClick={() => handleTransposeChange(-transpose)}
                aria-label="Reset transpose to zero"
              >
                Reset
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Voice Controls */}
      <div className="space-y-4">
        <h3 className="font-semibold dark:text-white">Voice Controls</h3>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {voiceControls.map(control => {
            const isSoloed = soloVoice === control.voice;
            const effectiveMuted = control.muted || (soloVoice !== null && !isSoloed);
            const colors = getVoiceColors(control.voice);
            return (
              <div
                key={control.voice}
                className={`flex items-center gap-3 p-3 border-2 rounded-lg dark:bg-gray-700 ${colors.border} ${effectiveMuted ? "opacity-40" : ""}`}
              >
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => toggleMute(control.voice)}
                  aria-label={control.muted ? `Unmute ${control.label}` : `Mute ${control.label}`}
                  className="dark:text-white"
                >
                  {effectiveMuted ? (
                    <VolumeX className="h-4 w-4" />
                  ) : (
                    <Volume2 className="h-4 w-4" />
                  )}
                </Button>

                <div className="flex-1 space-y-2">
                  <div className="flex items-center justify-between gap-1">
                    <div className="flex items-center gap-2">
                      <span className={`inline-block w-2 h-2 rounded-full ${colors.dot}`} />
                      <span className={`text-sm font-medium dark:text-gray-200 ${effectiveMuted ? "line-through" : ""}`}>{control.label}</span>
                      <kbd className="ml-1.5 text-[10px] font-mono text-muted-foreground/50 border border-muted-foreground/20 rounded px-1">
                        {voiceControls.indexOf(control) + 1}
                      </kbd>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button
                        variant={isSoloed ? "default" : "outline"}
                        size="sm"
                        onClick={() => handleSolo(control.voice)}
                        aria-pressed={isSoloed}
                        aria-label={`Solo ${control.label}`}
                        className="h-6 px-2 text-xs"
                      >
                        S
                      </Button>
                      {midiUrls[control.voice] && (
                        <a
                          href={midiUrls[control.voice]}
                          download={`${sheetTitle ? sanitizeFilename(sheetTitle) + "-" : ""}${control.label.toLowerCase()}.mid`}
                          aria-label={`Download ${control.label} MIDI`}
                        >
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-6 w-6 p-0"
                            asChild={false}
                            tabIndex={-1}
                          >
                            <Download className="h-3 w-3" />
                          </Button>
                        </a>
                      )}
                    </div>
                  </div>
                  <Slider
                    value={[control.volume]}
                    max={1}
                    step={0.01}
                    onValueChange={(value) => handleVolumeChange(control.voice, value)}
                    disabled={effectiveMuted}
                    className="w-full"
                    aria-label={`${control.label} volume control`}
                    aria-valuetext={`${Math.round(control.volume * 100)} percent`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(control.volume * 100)}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </Card>
  );
}
