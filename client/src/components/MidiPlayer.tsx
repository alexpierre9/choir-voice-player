import { useEffect, useRef, useState } from "react";
import * as Tone from "tone";
import { Midi } from "@tonejs/midi";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Card } from "@/components/ui/card";
import { Play, Pause, Square, Volume2, VolumeX } from "lucide-react";

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
  
  const synthsRef = useRef<Map<string, Tone.PolySynth>>(new Map());
  const partsRef = useRef<Map<string, Tone.Part>>(new Map());
  const midiDataRef = useRef<Map<string, Midi>>(new Map());
  const progressIntervalRef = useRef<NodeJS.Timeout | null>(null);

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
      
      try {
        // Create synths for each voice
        for (const voice of availableVoices) {
          if (voice === "all") continue; // Skip "all" voice
          
          const synth = new Tone.PolySynth(Tone.Synth, {
            oscillator: { type: "sine" },
            envelope: {
              attack: 0.005,
              decay: 0.1,
              sustain: 0.3,
              release: 0.5,
            },
          }).toDestination();
          
          synth.volume.value = -10; // Default volume
          synthsRef.current.set(voice, synth);
        }
        
        // Load MIDI data
        let maxDuration = 0;
        
        for (const voice of availableVoices) {
          if (voice === "all") continue;
          
          const url = midiUrls[voice];
          if (!url) continue;
          
          const response = await fetch(url);
          const arrayBuffer = await response.arrayBuffer();
          const midi = new Midi(arrayBuffer);
          
          midiDataRef.current.set(voice, midi);
          
          // Track max duration
          if (midi.duration > maxDuration) {
            maxDuration = midi.duration;
          }
          
          // Create Tone.Part for this voice
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
        }
        
        setDuration(maxDuration);
        setIsLoading(false);
      } catch (error) {
        console.error("Failed to load MIDI files:", error);
        setIsLoading(false);
      }
    };
    
    if (Object.keys(midiUrls).length > 0) {
      loadMidiFiles();
    }
    
    // Cleanup
    return () => {
      stopPlayback();
      synthsRef.current.forEach(synth => synth.dispose());
      partsRef.current.forEach(part => part.dispose());
      synthsRef.current.clear();
      partsRef.current.clear();
      midiDataRef.current.clear();
    };
  }, [midiUrls, availableVoices]);

  const startPlayback = async () => {
    await Tone.start();
    
    // Start all parts
    partsRef.current.forEach(part => {
      part.start(0);
    });
    
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
    setIsPlaying(false);
    
    if (progressIntervalRef.current) {
      clearInterval(progressIntervalRef.current);
      progressIntervalRef.current = null;
    }
  };

  const stopPlayback = () => {
    Tone.getTransport().stop();
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
    setVoiceControls(prev =>
      prev.map(vc =>
        vc.voice === voice ? { ...vc, muted: !vc.muted } : vc
      )
    );
    
    const synth = synthsRef.current.get(voice);
    if (synth) {
      const control = voiceControls.find(vc => vc.voice === voice);
      if (control) {
        synth.volume.value = control.muted ? 0 : Tone.gainToDb(control.volume);
      }
    }
  };

  const handleVolumeChange = (voice: string, value: number[]) => {
    const newVolume = value[0];
    
    setVoiceControls(prev =>
      prev.map(vc =>
        vc.voice === voice ? { ...vc, volume: newVolume } : vc
      )
    );
    
    const synth = synthsRef.current.get(voice);
    if (synth) {
      const control = voiceControls.find(vc => vc.voice === voice);
      if (control && !control.muted) {
        synth.volume.value = Tone.gainToDb(newVolume);
      }
    }
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  if (isLoading) {
    return (
      <Card className="p-6">
        <div className="text-center">Loading MIDI player...</div>
      </Card>
    );
  }

  return (
    <Card className="p-6 space-y-6">
      {/* Playback Controls */}
      <div className="space-y-4">
        <div className="flex items-center gap-4">
          <Button
            onClick={handlePlayPause}
            variant="default"
            size="lg"
            className="w-24"
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
          
          <Button onClick={handleStop} variant="outline" size="lg">
            <Square className="mr-2 h-4 w-4" />
            Stop
          </Button>
          
          <div className="flex-1 text-sm text-muted-foreground">
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
          />
        </div>
      </div>

      {/* Voice Controls */}
      <div className="space-y-4">
        <h3 className="font-semibold">Voice Controls</h3>
        
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {voiceControls.map(control => (
            <div
              key={control.voice}
              className="flex items-center gap-3 p-3 border rounded-lg"
            >
              <Button
                variant="ghost"
                size="icon"
                onClick={() => toggleMute(control.voice)}
              >
                {control.muted ? (
                  <VolumeX className="h-4 w-4" />
                ) : (
                  <Volume2 className="h-4 w-4" />
                )}
              </Button>
              
              <div className="flex-1 space-y-2">
                <div className="text-sm font-medium">{control.label}</div>
                <Slider
                  value={[control.volume]}
                  max={1}
                  step={0.01}
                  onValueChange={(value) => handleVolumeChange(control.voice, value)}
                  disabled={control.muted}
                  className="w-full"
                />
              </div>
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}

