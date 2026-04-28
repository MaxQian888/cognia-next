import { invoke } from "@tauri-apps/api/core"

/**
 * Detects whether the app is running inside a Tauri webview.
 * Use this to gate any code that calls `invoke` so the same component
 * works in both `pnpm dev` (web) and `pnpm tauri dev` (desktop).
 */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
}

// Type-safe wrappers for Rust commands defined in src-tauri/src/commands.rs.
// Keep this file as the SOLE caller of `invoke` — business code imports
// named functions from here, never `invoke` directly.

export async function greet(name: string): Promise<string> {
  return invoke<string>("greet", { name })
}
