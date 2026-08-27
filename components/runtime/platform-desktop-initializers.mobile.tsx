/**
 * Capacitor variant of the desktop boot initializers — see
 * `platform-desktop-initializers.tsx`.
 *
 * Every initializer in that bundle is a Tauri main-window boot concern
 * (window show/heartbeat, terminal + CLI bridges, updater, deep-link routers,
 * tray panel, crash dialog). `isTauri()` is false on Capacitor by
 * construction, so the bundle could only ever render `null` here — render it
 * without shipping the chunks.
 */

export function PlatformDesktopInitializers() {
  return null
}
