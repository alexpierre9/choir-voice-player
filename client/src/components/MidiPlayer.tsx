import { useEffect, useRef, useState } from "react";
import * as Tone from "tone";
import { Midi } from "@tonejs/midi";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Card } from "@/components/ui/card";
import { Play, Pause, Square, Volume2, VolumeX, Loader2, AlertCircle } from "lucide-react";

interface VoiceControl {
  voice: string;
  label: string;
  muted: boolean;
  volume: number;
}

interface MidiPlayerProps {
  midiUrls: Record<string, string>; // { soprano: url, alto: url, ... }
  availableVoices: string[];
}

export default function MidiPlayer({ midiUrls, availableVoices }: MidiPlayerProps) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [voiceControls, setVoiceControls] = useState<VoiceControl[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [failedVoices, setFailedVoices] = useState<string[]>([]);

  const synthsRef = useRef<Map<string, Tone.PolySynth>>(new Map());
  const partsRef = useRef<Map<string, Tone.Part>>(new Map());
  const midiDataRef = useRef<Map<string, Midi>>(new Map());
  const progressIntervalRef = useRef<NodeJS.Timeout | null>(null);
  // Track whether we're resuming from a pause (true) vs starting fresh (false).
  // When resuming, the Transport's position and the already-scheduled Part events
  // are still intact — we must NOT cancel/reset them or playback restarts from 0.
  const isPausedRef = useRef(false);

  // Voice labels mapping
  const voiceLabels: Record<string, string> = {
    soprano: "Soprano",
    alto: "Alto",
    tenor: "Tenor",
    bass: "Bass",
    all: "All Voices",
  };

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

  // Load MIDI files
  useEffect(() => {
    const loadMidiFiles = async () => {
      setIsLoading(true);

      const failed: string[] = [];
      let maxDuration = 0;

      for (const voice of availableVoices) {
        if (voice === "all") continue;

        try {
          // Create synth for this voice
          const synth = new Tone.PolySynth(Tone.Synth, {
            oscillator: { type: "sine" },
            envelope: {
              attack: 0.005,
              decay: 0.1,
              sustain: 0.3,
              release: 0.5,
            },
          }).toDestination();

          synth.volume.value = -10;
          synthsRef.current.set(voice, synth);

          const url = midiUrls[voice];
          if (!url) {
            failed.push(voice);
            continue;
          }

          const response = await fetch(url);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const arrayBuffer = await response.arrayBuffer();
          const midi = new Midi(arrayBuffer);

          midiDataRef.current.set(voice, midi);

          if (midi.duration > maxDuration) {
            maxDuration = midi.duration;
          }

          const notes: any[] = [];
          midi.tracks.forEach(track => {
            track.notes.forEach(note => {
              notes.push({
                time: note.time,
                note: note.name,
                duration: note.duration,
                velocity: note.velocity,
              });
            });
          });

          const part = new Tone.Part((time, note) => {
            const synth = synthsRef.current.get(voice);
            if (synth) {
              synth.triggerAttackRelease(
                note.note,
                note.duration,
                time,
                note.velocity
              );
            }
          }, notes);

          part.loop = false;
          partsRef.current.set(voice, part);
        } catch (error) {
          console.error(`Failed to load MIDI for voice "${voice}":`, error);
          failed.push(voice);
        }
      }

      setFailedVoices(failed);

      if (failed.length === availableVoices.filter(v => v !== "all").length) {
        // All voices failed
        setLoadError("Failed to load MIDI files. Please refresh the page and try again.");
      }

      setDuration(maxDuration);
      setIsLoading(false);
    };

    if (Object.keys(midiUrls).length > 0) {
      loadMidiFiles();
    }

    // Cleanup
    return () => {
      stopPlayback();

      // Dispose of all synths
      synthsRef.current.forEach(synth => {
        try {
          synth.dispose();
        } catch (e) {
          console.warn("Error disposing synth:", e);
        }
      });

      // Dispose of all parts
      partsRef.current.forEach(part => {
        try {
          part.dispose();
        } catch (e) {
          console.warn("Error disposing part:", e);
        }
      });

      // Clear all references
      synthsRef.current.clear();
      partsRef.current.clear();
      midiDataRef.current.clear();

      // Clear any remaining intervals
      if (progressIntervalRef.current) {
        clearInterval(progressIntervalRef.current);
        progressIntervalRef.current = null;
      }
    };
  }, [midiUrls, availableVoices]);

  const startPlayback = async () => {
    await Tone.start();

    if (!isPausedRef.current) {
      // Fresh start (or after Stop): cancel any previously scheduled events and
      // reset the transport position so playback begins at the start.
      // This prevents doubled notes if the user plays → stops → plays again.
      Tone.getTransport().cancel(0);
      Tone.getTransport().seconds = 0;

      // (Re-)schedule all parts from beat 0
      partsRef.current.forEach(part => {
        part.start(0);
      });
    }
    // If isPausedRef.current === true, the Transport position and scheduled Part
    // events were preserved by pause() — just call start() to resume in place.

    isPausedRef.current = false;
    Tone.getTransport().start();
    setIsPlaying(true);

    // Update progress
    progressIntervalRef.current = setInterval(() => {
      const currentTime = Tone.getTransport().seconds;
      setProgress(currentTime);

      if (currentTime >= duration) {
        stopPlayback();
      }
    }, 100);
  };

  const pausePlayback = () => {
    Tone.getTransport().pause();
    isPausedRef.current = true;
    setIsPlaying(false);

    if (progressIntervalRef.current) {
      clearInterval(progressIntervalRef.current);
      progressIntervalRef.current = null;
    }
  };

  const stopPlayback = () => {
    Tone.getTransport().stop();
    Tone.getTransport().seconds = 0; // Reset position so replay starts from beginning
    isPausedRef.current = false; // Next play should be a fresh start, not a resume
    setIsPlaying(false);
    setProgress(0);

    if (progressIntervalRef.current) {
      clearInterval(progressIntervalRef.current);
      progressIntervalRef.current = null;
    }

    // Stop all parts
    partsRef.current.forEach(part => {
      part.stop();
    });
  };

  const handlePlayPause = () => {
    if (isPlaying) {
      pausePlayback();
    } else {
      startPlayback();
    }
  };

  const handleStop = () => {
    stopPlayback();
  };

  const handleProgressChange = (value: number[]) => {
    const newTime = value[0];
    Tone.getTransport().seconds = newTime;
    setProgress(newTime);
  };

  const toggleMute = (voice: string) => {
    setVoiceControls(prev => {
      const newVoiceControls = prev.map(vc =>
        vc.voice === voice ? { ...vc, muted: !vc.muted } : vc
      );

      // Update the synth volume immediately after state update
      const synth = synthsRef.current.get(voice);
      if (synth) {
        const updatedControl = newVoiceControls.find(vc => vc.voice === voice);
        if (updatedControl) {
          synth.volume.value = updatedControl.muted ? -Infinity : Tone.gainToDb(updatedControl.volume);
        }
      }

      return newVoiceControls;
    });
  };

  const handleVolumeChange = (voice: string, value: number[]) => {
    const newVolume = value[0];

    setVoiceControls(prev => {
      const newVoiceControls = prev.map(vc =>
        vc.voice === voice ? { ...vc, volume: newVolume } : vc
      );

      // Update the synth volume immediately after state update
      const synth = synthsRef.current.get(voice);
      if (synth) {
        const updatedControl = newVoiceControls.find(vc => vc.voice === voice);
        if (updatedControl && !updatedControl.muted) {
          synth.volume.value = Tone.gainToDb(newVolume);
        }
      }

      return newVoiceControls;
    });
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  if (isLoading) {
    return (
      <Card className="p-6 dark:bg-gray-800 dark:border-gray-700">
        <div className="text-center" role="status" aria-live="polite">
          <Loader2 className="h-8 w-8 animate-spin mx-auto mb-2 text-blue-500 dark:text-blue-400" />
          <p className="text-sm text-gray-600 dark:text-gray-300">Loading MIDI player...</p>
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

        {/* Progress Bar */}
        <div className="space-y-2">
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

      {/* Voice Controls */}
      <div className="space-y-4">
        <h3 className="font-semibold dark:text-white">Voice Controls</h3>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {voiceControls.map(control => (
            <div
              key={control.voice}
              className="flex items-center gap-3 p-3 border rounded-lg dark:bg-gray-700 dark:border-gray-600"
            >
              <Button
                variant="ghost"
                size="icon"
                onClick={() => toggleMute(control.voice)}
                className="dark:text-white"
              >
                {control.muted ? (
                  <VolumeX className="h-4 w-4" />
                ) : (
                  <Volume2 className="h-4 w-4" />
                )}
              </Button>

              <div className="flex-1 space-y-2">
                <div className="text-sm font-medium dark:text-gray-200">{control.label}</div>
                <Slider
                  value={[control.volume]}
                  max={1}
                  step={0.01}
                  onValueChange={(value) => handleVolumeChange(control.voice, value)}
                  disabled={control.muted}
                  className="w-full"
                  aria-label={`${control.label} volume control`}
                  aria-valuetext={`${Math.round(control.volume * 100)} percent`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(control.volume * 100)}
                />
              </div>
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}

