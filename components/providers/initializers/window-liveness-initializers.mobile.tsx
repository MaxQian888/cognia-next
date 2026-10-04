/**
 * Capacitor compilation boundary. Window reveal, heartbeat and close confirmation are Tauri window concerns.
 * Keep the default variant for Web/Tauri without importing its native graph here.
 */
export function WindowLivenessInitializers() {
  return null
}

export default WindowLivenessInitializers
