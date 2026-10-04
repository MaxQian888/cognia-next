/**
 * Capacitor compilation boundary. The local Tauri MCP event bridge does not run on Capacitor.
 * Keep the default variant for Web/Tauri without importing its native graph here.
 */
export function McpLogProvider({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
