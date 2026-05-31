/**
 * Module-scope transport instance.
 *
 * Lives in its own file so it stays OUT of the
 *   `lib/tauri.ts → lib/tauri/index.ts → lib/tauri/<wrapper>.ts → lib/tauri.ts`
 * circular import chain. Eager evaluation here is safe because nothing in
 * `lib/tauri/<wrapper>.ts` imports from this file directly — they import
 * `transport` from `@/lib/tauri`, which re-exports it.
 *
 * Selection happens once at module load:
 *   - Tauri desktop  → `TauriTransport`
 *   - Capacitor mobile → `CompanionTransport` (real HTTP+WS impl, M2.7)
 *   - Plain web      → `WebStubTransport`
 */

import { isCapacitor, isTauri } from "@/lib/platform/detect"
import { CompanionTransport } from "./transport-companion"
import { TauriTransport } from "./transport-tauri"
import type { Transport } from "./transport-types"
import { WebStubTransport } from "./transport-web"

function pickTransport(): Transport {
  if (isTauri()) return new TauriTransport()
  if (isCapacitor()) return new CompanionTransport()
  return new WebStubTransport()
}

export const transport: Transport = pickTransport()
