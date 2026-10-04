/**
 * Capacitor compilation boundary. Capacitor uses its native lifecycle, not browser PWA installation events.
 * Keep the default variant for Web/Tauri without importing its native graph here.
 */
export function PwaLifecycleInitializer() {
  return null
}

export default PwaLifecycleInitializer
