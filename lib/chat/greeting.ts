/**
 * Time-of-day greeting slot for the chat welcome page (`EmptyChatState`).
 *
 * Maps a local wall-clock hour to one of four slots so the welcome heading can
 * read "Good morning / afternoon / evening" (and a quieter late-night variant).
 * Pure + dependency-free so it's trivially testable and reusable.
 */

export type GreetingSlot = "morning" | "afternoon" | "evening" | "night"

/**
 * Resolve the greeting slot for `date` (defaults to now) using its **local**
 * hour:
 *
 *  - `night`     — 00:00–04:59 and 22:00–23:59
 *  - `morning`   — 05:00–11:59
 *  - `afternoon` — 12:00–17:59
 *  - `evening`   — 18:00–21:59
 */
export function greetingSlot(date: Date = new Date()): GreetingSlot {
  const hour = date.getHours()
  if (hour < 5) return "night"
  if (hour < 12) return "morning"
  if (hour < 18) return "afternoon"
  if (hour < 22) return "evening"
  return "night"
}
