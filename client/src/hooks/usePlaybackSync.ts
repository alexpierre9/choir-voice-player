import {
  createContext,
  useContext,
  useState,
  useCallback,
  type ReactNode,
  createElement,
} from "react";

// ── Types ────────────────────────────────────────────────────────────────────

interface PlaybackState {
  currentTimeSec: number;
  isPlaying: boolean;
  totalDuration: number;
}

interface PlaybackSyncContextValue extends PlaybackState {
  publishPlayback: (
    currentTimeSec: number,
    isPlaying: boolean,
    totalDuration?: number
  ) => void;
}

// ── Context ──────────────────────────────────────────────────────────────────

const PlaybackSyncContext = createContext<PlaybackSyncContextValue | null>(null);

// ── Provider ─────────────────────────────────────────────────────────────────

export function PlaybackSyncProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [state, setState] = useState<PlaybackState>({
    currentTimeSec: 0,
    isPlaying: false,
    totalDuration: 0,
  });

  const publishPlayback = useCallback(
    (currentTimeSec: number, isPlaying: boolean, totalDuration?: number) => {
      setState((prev) => ({
        currentTimeSec,
        isPlaying,
        totalDuration: totalDuration !== undefined ? totalDuration : prev.totalDuration,
      }));
    },
    []
  );

  return createElement(
    PlaybackSyncContext.Provider,
    { value: { ...state, publishPlayback } },
    children
  );
}

// ── Hooks ─────────────────────────────────────────────────────────────────────

/**
 * Returns the playback sync context, or null if not inside a PlaybackSyncProvider.
 * NotationEditor (follow mode) uses this to read playback state.
 */
export function usePlaybackSync(): PlaybackSyncContextValue | null {
  return useContext(PlaybackSyncContext);
}

/**
 * Returns the publishPlayback function — falls back to a stable no-op when
 * MidiPlayer is rendered outside a PlaybackSyncProvider (e.g. in isolation).
 */
export function usePublishPlayback(): (
  currentTimeSec: number,
  isPlaying: boolean,
  totalDuration?: number
) => void {
  const ctx = useContext(PlaybackSyncContext);

  // Stable no-op for when there's no provider
  const noOp = useCallback(
    (_time: number, _playing: boolean, _duration?: number) => {},
    []
  );

  return ctx?.publishPlayback ?? noOp;
}
