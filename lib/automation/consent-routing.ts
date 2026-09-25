/**
 * Which window answers which automation consent prompt.
 *
 * Every prompt is broadcast to every window (`automation:consent-request`),
 * and the main window's `<ConsentOverlay>` answers all of them. A feature that
 * shows its own prompt, where the user is actually looking, claims its
 * surface here while it does (ADR-0194 §8: the desktop chat copilot asks from
 * its overlay beside the chat window, since the main window is usually behind
 * it). The main overlay then hides that surface's prompts, and shows them
 * again the moment the claim is released, so a prompt is never left with
 * nobody to answer it.
 *
 * A prompt answered elsewhere is marked settled so the main overlay drops it
 * immediately instead of waiting out its countdown.
 */

import type { ConsentPromptPayload, ConsentRequestEvent, Surface } from "./client"

export const CONSENT_REQUEST_EVENT = "automation:consent-request"

/** Settled ids kept to hide late duplicates; far above any real queue. */
const MAX_SETTLED = 256

const claims = new Map<Surface, number>()
const settled: string[] = []
const listeners = new Set<() => void>()
let version = 0

function changed(): void {
  version += 1
  for (const listener of listeners) listener()
}

/** The prompt fields a persisted grant is keyed by (see `ConsentPromptPayload`). */
export function consentPromptOf(event: ConsentRequestEvent): ConsentPromptPayload {
  return {
    command: event.command,
    surface: event.surface,
    pluginId: event.pluginId,
    processName: event.processName,
    windowTitle: event.windowTitle,
    commandDetail: event.commandDetail ?? null,
    // Part of the host's grant key — omitting it would register the grant
    // under an empty session tag, so it would never match the prompts it was
    // meant to cover and the user would be re-asked every call.
    sessionKey: event.sessionKey ?? null,
  }
}

/** Take over `surface`'s prompts. The returned release is idempotent. */
export function claimConsentSurface(surface: Surface): () => void {
  claims.set(surface, (claims.get(surface) ?? 0) + 1)
  changed()
  let released = false
  return () => {
    if (released) return
    released = true
    const count = (claims.get(surface) ?? 1) - 1
    if (count > 0) claims.set(surface, count)
    else claims.delete(surface)
    changed()
  }
}

export function markConsentSettled(id: string): void {
  if (settled.includes(id)) return
  settled.push(id)
  if (settled.length > MAX_SETTLED) settled.shift()
  changed()
}

/** True when another window answers this prompt, or already has. */
export function isConsentRoutedElsewhere(event: Pick<ConsentRequestEvent, "id" | "surface">) {
  return claims.has(event.surface) || settled.includes(event.id)
}

export function subscribeConsentRouting(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** A counter that moves on every routing change (a `useSyncExternalStore` snapshot). */
export function getConsentRoutingVersion(): number {
  return version
}

/** Test-only: forget every claim and settled id. */
export function __resetConsentRouting(): void {
  claims.clear()
  settled.length = 0
  changed()
}
