/**
 * soundfontPlayer.ts
 *
 * Wrapper around the `smplr` Soundfont API for choir voice playback.
 * Provides lazy loading, per-instrument caching, and a uniform interface
 * that MidiPlayer.tsx can use in place of Tone.PolySynth.
 */

import { Soundfont } from "smplr";

// ----- Voice → GM instrument mapping -----

export const VOICE_INSTRUMENTS: Record<string, string> = {
  soprano: "choir_aahs", // GM 52 — bright, high
  alto: "choir_aahs",    // GM 52
  tenor: "voice_oohs",   // GM 53 — warmer, lower
  bass: "voice_oohs",    // GM 53
};

// ----- VoiceSynth discriminated union -----
// MidiPlayer works with either a real Soundfont instrument or a Tone.PolySynth fallback.

import type * as Tone from "tone";

export type VoiceSynth =
  | { type: "soundfont"; instrument: Soundfont }
  | { type: "polySynth"; synth: Tone.PolySynth };

// ----- Cache: keyed by AudioContext + instrument name -----

// We use a WeakMap on the AudioContext so cached instruments are garbage-collected
// when the context is closed.  Map value: instrument name → Soundfont instance.
/**
 * Create a NEW Soundfont instrument instance for the given AudioContext.
 * Each voice MUST have its own instance — sharing one Soundfont object between
 * soprano/alto (or tenor/bass) would mean volume/mute/solo on one voice
 * affects the other, since they share the same output node.
 *
 * The browser caches the underlying .sf2 fetch, so multiple instances of the
 * same instrument name don't re-download the samples.
 */
export async function loadSoundfontInstrument(
  context: AudioContext,
  instrumentName: string,
): Promise<Soundfont> {
  const instrument = new Soundfont(context, { instrument: instrumentName });
  await instrument.load;
  return instrument;
}

// ----- Uniform helpers -----

/**
 * Trigger a single note on a VoiceSynth.
 * @param time   Absolute AudioContext time (seconds) at which to start the note.
 * @param velocity Normalised velocity from @tonejs/midi (0–1).
 */
export function playSynthNote(
  synth: VoiceSynth,
  note: string,
  duration: number,
  time: number,
  velocity: number, // 0-1 from @tonejs/midi
): void {
  if (synth.type === "soundfont") {
    synth.instrument.start({
      note,
      duration,
      time,
      velocity: Math.round(velocity * 127), // convert to MIDI 0-127
    });
  } else {
    synth.synth.triggerAttackRelease(note, duration, time, velocity);
  }
}

/**
 * Apply effective volume to a VoiceSynth.
 * @param volume   Normalised volume (0–1).
 * @param muted    Whether the voice should be silent.
 */
export function setSynthVolume(synth: VoiceSynth, volume: number, muted: boolean): void {
  if (synth.type === "soundfont") {
    synth.instrument.output.setVolume(muted ? 0 : Math.round(volume * 100));
  } else {
    // Tone.js uses dB; import gainToDb from "tone" at call site or compute here
    synth.synth.volume.value = muted ? -Infinity : 20 * Math.log10(Math.max(volume, 1e-6));
  }
}

/**
 * Stop all active notes on a VoiceSynth.
 */
export function stopSynth(synth: VoiceSynth): void {
  if (synth.type === "soundfont") {
    synth.instrument.stop();
  } else {
    synth.synth.releaseAll();
  }
}

/**
 * Disconnect / dispose a VoiceSynth, freeing resources.
 */
export function disposeSynth(synth: VoiceSynth): void {
  if (synth.type === "soundfont") {
    synth.instrument.disconnect();
  } else {
    try { synth.synth.dispose(); } catch (_) {}
  }
}
