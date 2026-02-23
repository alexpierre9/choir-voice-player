/** Tailwind CSS classes and accent colors for each SATB voice. */
export const VOICE_COLORS: Record<string, { border: string; badge: string; dot: string }> = {
  soprano: {
    border: "border-pink-300 dark:border-pink-700",
    badge: "bg-pink-100 text-pink-800 dark:bg-pink-900/40 dark:text-pink-300",
    dot: "bg-pink-400",
  },
  alto: {
    border: "border-purple-300 dark:border-purple-700",
    badge: "bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300",
    dot: "bg-purple-400",
  },
  tenor: {
    border: "border-blue-300 dark:border-blue-700",
    badge: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
    dot: "bg-blue-400",
  },
  bass: {
    border: "border-green-300 dark:border-green-700",
    badge: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300",
    dot: "bg-green-400",
  },
  other: {
    border: "border-gray-300 dark:border-gray-600",
    badge: "bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300",
    dot: "bg-gray-400",
  },
};

export function getVoiceColors(voice: string) {
  return VOICE_COLORS[voice.toLowerCase()] ?? VOICE_COLORS.other;
}
