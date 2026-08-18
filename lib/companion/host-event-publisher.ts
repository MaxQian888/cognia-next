/**
 * Host-side event publisher seam (ADR-0131 cross-shell inbox relay, Slice 2.4).
 *
 * The connector runtime runs on exactly one host at a time — the Tauri
 * desktop webview or the headless brain — and both need to fan events out to
 * paired thin clients through the Rust companion event bus
 * (`src-tauri/src/companion_api/event_channels.rs`). The two hosts reach that
 * bus differently:
 *
 *  - Desktop webview: a plain Tauri `emit(topic, payload)`; the Rust side
 *    forwards every `tauri_forwarded` channel to WS subscribers and push
 *    triggers (`register_default_event_channels`).
 *  - Headless brain: no Tauri runtime. `lib/headless/runtimes/connector-runtime.ts`
 *    registers a publisher that pipes `{ topic, event }` through
 *    `ctx.bridge.invoke("companion_event_publish", …)`, which
 *    `ws_bridge.rs:route_respond` validates against a topic allowlist before
 *    publishing on the same bus.
 *  - Anywhere else (browser / mobile / tests): no-op — thin clients never
 *    publish host events.
 *
 * Callers (`lib/sync/host-invalidate.ts`, `lib/connectors/inbox-relay/host-events.ts`)
 * treat delivery as best-effort: a lost frame degrades to the existing
 * foreground / resume / network sync triggers on the client.
 */

import { isTauri } from "@/lib/platform/detect"

export type HostEventPublisher = (topic: string, payload: unknown) => void | Promise<void>

let registeredPublisher: HostEventPublisher | null = null

/**
 * Register (or clear, with `null`) the active publisher. Returns an
 * unregister function that only clears the slot if it still holds THIS
 * publisher — a later registration is never clobbered by an earlier
 * unregister racing it.
 */
export function setHostEventPublisher(publisher: HostEventPublisher | null): () => void {
  registeredPublisher = publisher
  return () => {
    if (registeredPublisher === publisher) registeredPublisher = null
  }
}

/** The publisher currently installed, or `null`. Test/diagnostic seam. */
export function getHostEventPublisher(): HostEventPublisher | null {
  return registeredPublisher
}

/**
 * Publish one host event. Resolution order: registered publisher (headless
 * brain) → Tauri `emit` (desktop webview) → no-op. Never throws — every
 * failure is swallowed because the callers are DB writers on the hot path
 * and must not fail a persisted mutation over a lost notification.
 */
export async function publishHostEvent(topic: string, payload: unknown): Promise<void> {
  try {
    if (registeredPublisher) {
      await registeredPublisher(topic, payload)
      return
    }
    if (!isTauri()) return
    const moduleId = "@tauri-apps/api/event"
    const mod = (await import(/* webpackIgnore: true */ moduleId)) as {
      emit: (event: string, payload: unknown) => Promise<void>
    }
    await mod.emit(topic, payload)
  } catch {
    // Best-effort — see module doc.
  }
}

/** Test-only reset of the module slot. */
export function __resetHostEventPublisherForTests(): void {
  registeredPublisher = null
}
