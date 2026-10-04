/**
 * Capacitor compilation boundary. Both trust and allowed-root synchronization target the local Tauri host only.
 * Keep the default variant for Web/Tauri without importing its native graph here.
 */
export function HookTrustSyncProvider({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
