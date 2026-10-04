/**
 * Capacitor compilation boundary. Local Tauri sidecar spans are not emitted by the Capacitor runtime.
 * Keep the default variant for Web/Tauri without importing its native graph here.
 */
export function SidecarSpanProvider({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
