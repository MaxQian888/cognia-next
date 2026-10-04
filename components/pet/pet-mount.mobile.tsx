/**
 * Capacitor compilation boundary. Pet availability requires Tauri; Capacitor has no desktop pet window.
 * Keep the default variant for Web/Tauri without importing its native graph here.
 */
export function PetMount() {
  return null
}
