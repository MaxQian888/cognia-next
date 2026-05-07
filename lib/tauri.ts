import { TauriTransport } from "./tauri/transport-tauri"
import type { Transport } from "./tauri/transport-types"
import { WebStubTransport } from "./tauri/transport-web"

/**
 * Detects whether the app is running inside a Tauri webview.
 * Use this to gate any code that calls into native runtime so the same
 * component works in both `pnpm dev` (web) and `pnpm tauri dev` (desktop).
 */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
}

/**
 * Module-scope transport selection. Picked once at module load — the runtime
 * context can't change inside a single page session, so re-checking on every
 * call would add no value.
 *
 * M1.6 extends this to also detect Capacitor and pick `CompanionTransportStub`
 * (and eventually the real `CompanionTransport` in M2.7).
 */
export const transport: Transport = isTauri() ? new TauriTransport() : new WebStubTransport()

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
