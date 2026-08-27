/**
 * Capacitor variant of the desktop companion source providers — see
 * `platform-desktop-sources.tsx`.
 *
 * The phone consumes companion deltas, it never produces them: both providers
 * gate on `usePlatform() === "tauri"` and would be inert here. Pass children
 * through so the Capacitor bundle carries none of the desktop bridge graph.
 */

export function PlatformDesktopSources({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
