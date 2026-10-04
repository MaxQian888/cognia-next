/**
 * Capacitor compilation boundary. Usage listeners consume local Tauri events; Capacitor does not register them.
 * Keep the default variant for Web/Tauri without importing its native graph here.
 */
export function SubscriptionUsageProvider({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
