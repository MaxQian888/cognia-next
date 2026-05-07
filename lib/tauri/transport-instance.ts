/**
 * Module-scope transport instance.
 *
 * Lives in its own file so it stays OUT of the
 *   `lib/tauri.ts → lib/tauri/index.ts → lib/tauri/<wrapper>.ts → lib/tauri.ts`
 * circular import chain. Eager evaluation here is safe because nothing in
 * `lib/tauri/<wrapper>.ts` imports from this file directly — they import
 * `transport` from `@/lib/tauri`, which re-exports it.
 *
 * M1.6 will detect Capacitor here and pick `CompanionTransportStub`
 * (and eventually the real `CompanionTransport` in M2.7).
 */

import { TauriTransport } from "./transport-tauri"
import type { Transport } from "./transport-types"
import { WebStubTransport } from "./transport-web"

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
}

export const transport: Transport = isTauri() ? new TauriTransport() : new WebStubTransport()
