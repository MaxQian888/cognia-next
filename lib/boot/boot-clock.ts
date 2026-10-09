/**
 * Boot clock formatting — the two ways the boot screens print time, shared by
 * the desktop (`components/boot/boot-screen.tsx`) and phone
 * (`components/mobile/splash/mobile-boot-screen.tsx`) screens so a step reads
 * the same on both.
 */

/** A finished step's measured duration, in seconds to one decimal (never "0.0"). */
export function formatBootDuration(ms: number): string {
  return Math.max(0.1, ms / 1000).toFixed(1)
}

/**
 * Whole seconds since `since` for a live counter, or `null` while there is no
 * anchor or under a second has passed — a counter that opens on "0s" reads as
 * stuck rather than started.
 */
export function liveBootSeconds(now: number, since: number | null): number | null {
  if (since === null) return null
  const seconds = Math.floor((now - since) / 1000)
  return seconds >= 1 ? seconds : null
}
