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
import { hasWebCompanionTarget } from "@/lib/platform/web-companion"
import { CompanionTransport } from "./transport-companion"
import { RoutingTransport } from "./transport-routing"
import { TauriTransport } from "./transport-tauri"
import type { Transport } from "./transport-types"
import { WebStubTransport } from "./transport-web"

function pickTransport(): Transport {
  // Desktop wraps the local transport in a RoutingTransport (ADR-0082) so the
  // app can drive a remote Cognia host once one is activated. With no remote
  // host active it delegates straight through to the local `TauriTransport`
  // (zero behaviour change); the remote-host store installs/clears the active
  // remote via `setActiveRemoteTransport`.
  if (isTauri()) return new RoutingTransport(new TauriTransport())
  if (isCapacitor()) return new CompanionTransport()
  // Cloud companion (ADR-0059 C1): a plain browser with a cognia-server —
  // build-time NEXT_PUBLIC_COGNIA_SERVER_URL or an existing pairing — talks
  // the same companion protocol Capacitor does.
  if (hasWebCompanionTarget()) return new CompanionTransport()
  return new WebStubTransport()
}

// `let` (not `const`) so a non-browser host can install its own implementation
// at startup via `setTransport`. The standalone agent CLI uses this to swap in
// a `StdioTransport` that drives the Node sidecar directly — letting it reuse
// the desktop's `runAndCaptureAssistantReply` loop unchanged. The export is a
// live ES binding, so every `import { transport } from "@/lib/tauri"` consumer
// (which reads it per-call, never captures it) sees the swap.
export let transport: Transport = pickTransport()

const transportChangeHandlers = new Set<() => void>()

/**
 * Be told when {@link transport} is replaced.
 *
 * The live ES binding is enough for a caller that reads `transport.foo()` per
 * call, and not enough for one that *subscribes*: a listener registered on the
 * old instance keeps listening to it after the swap, and `setTransport`
 * destroys that instance — whose teardown broadcasts `offline` as its last act.
 *
 * That is how a browser could hold a fully connected Host (RPC answering, the
 * event socket open and `stream_ready` received) while the status bar read
 * "Offline" forever: `useConnectionState` subscribed once at mount, pairing
 * then swapped in a fresh `CompanionTransport`, and the hook spent the rest of
 * the session listening to a corpse.
 *
 * Returns an unsubscribe function.
 */
export function onTransportChange(handler: () => void): () => void {
  transportChangeHandlers.add(handler)
  return () => {
    transportChangeHandlers.delete(handler)
  }
}

/**
 * Replace the process-wide transport. Intended for non-browser hosts (the CLI)
 * to install a custom {@link Transport} before any consumer issues a call, and
 * for the browser to swap the stub for a real companion transport once a
 * pairing exists.
 *
 * No-op-safe to call multiple times; the last writer wins. Handlers registered
 * through {@link onTransportChange} run after the swap, so a re-subscribing
 * consumer binds to the new instance and never to the destroyed one.
 */
export function setTransport(next: Transport): void {
  const previous = transport as Transport & { destroy?: () => void }
  if (previous === next) return
  previous.destroy?.()
  transport = next
  for (const handler of transportChangeHandlers) {
    try {
      handler()
    } catch {
      // One consumer failing to re-bind must not stop the others.
    }
  }
}
