import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Format a duration in seconds as `M:SS` for video/audio scrubbers.
 */
export function formatVideoTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00"
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins}:${secs.toString().padStart(2, "0")}`
}

/**
 * Format a duration in milliseconds as a short human label
 * (e.g. `350ms`, `2.4s`, `1m 12s`). Used by agent UIs.
 */
export function formatDurationShort(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) {
    return "—"
  }
  if (ms < 1000) return `${Math.round(ms)}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  if (m < 60) return `${m}m ${s}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

// Re-export for code copied from upstream that imports `isTauri` from `@/lib/utils`.
export { isTauri } from "./tauri"

/**
 * Tailwind class for SelectTrigger / Combobox / fixed-width form controls
 * inside settings panels. Mobile-first: `w-full` keeps the trigger from
 * overflowing on narrow screens; `sm:w-64` restores the historical 256px
 * layout once we have room for it. Reach for this whenever you'd be
 * tempted to write `className="w-64"`.
 */
export const responsiveSelectClass = "w-full sm:w-64"
