/**
 * Capacitor compilation boundary. This initializer badges installed browser PWAs only, not native apps.
 * Keep the default variant for Web/Tauri without importing its native graph here.
 */
export function PwaBadgeInitializer() {
  return null
}

export default PwaBadgeInitializer
