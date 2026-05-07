import { transport } from "./tauri/transport-instance"

/**
 * Detects whether the app is running inside a Tauri webview.
 * Use this to gate any code that calls into native runtime so the same
 * component works in both `pnpm dev` (web) and `pnpm tauri dev` (desktop).
 */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
}

/**
 * Detects whether the app is running inside a Capacitor mobile shell.
 * Use this for UI gating that needs to know the native runtime is mobile
 * (versus desktop Tauri or plain browser). The transport selection itself
 * happens in `lib/tauri/transport-instance.ts` — this helper is only for
 * UI-level platform branching alongside `isTauri()`.
 */
export function isCapacitor(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof (window as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor
      ?.isNativePlatform === "function" &&
    (window as { Capacitor: { isNativePlatform: () => boolean } }).Capacitor.isNativePlatform() ===
      true
  )
}

// Re-export the transport so consumers can `import { transport } from "@/lib/tauri"`.
// The actual instance lives in `lib/tauri/transport-instance.ts` to stay out
// of the circular import chain that runs through this barrel.
export { transport }

// Type-safe wrappers for Rust commands defined in src-tauri/src/commands.rs.
// Keep this file as the SOLE authoritative seam — business code imports named
// functions from here, never `invoke` directly.

export async function greet(name: string): Promise<string> {
  return transport.call<string>("greet", { name })
}

// Re-export every plugin wrapper as a named import surface. Consumers can do
//   import { openExternal, notify, getOsInfo } from "@/lib/tauri"
// without knowing which sub-module they live in.
export * from "./tauri/index"
