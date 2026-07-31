/**
 * Session → deployment affinity (LiteLLM deployment-affinity / prompt-cache
 * affinity analog). After a successful turn the session is SOFT-pinned to the
 * deployment that served it, so multi-turn conversations keep hitting the same
 * provider:model — better prompt-cache hit rates and consistent behavior.
 *
 * Plain in-memory Map (NOT zustand, NOT persisted): pins are routing hints,
 * not state anyone subscribes to. TTL'd so idle conversations release their
 * pin; the affinity filter additionally releases pins whose deployment has
 * become unavailable (breaker open / cooled down).
 */

/** How long a pin survives without being refreshed. */
export const DEFAULT_AFFINITY_TTL_MS = 30 * 60 * 1000

interface AffinityPin {
  deploymentKey: string
  pinnedAt: number
}

const pins = new Map<string, AffinityPin>()

/** Pin a session to the deployment that just served it successfully. */
export function pinSessionDeployment(
  sessionId: string,
  deploymentKey: string,
  now: number = Date.now()
): void {
  if (!sessionId || !deploymentKey) return
  pins.set(sessionId, { deploymentKey, pinnedAt: now })
}

/** The session's pinned deployment key, if the pin is still fresh. */
export function getSessionDeployment(
  sessionId: string,
  now: number = Date.now(),
  ttlMs: number = DEFAULT_AFFINITY_TTL_MS
): string | undefined {
  const pin = pins.get(sessionId)
  if (!pin) return undefined
  if (now - pin.pinnedAt > ttlMs) {
    pins.delete(sessionId)
    return undefined
  }
  return pin.deploymentKey
}

/** Release a session's pin (permanent failure / unhealthy deployment). */
export function releaseSessionDeployment(sessionId: string): void {
  pins.delete(sessionId)
}

/** Test-only: clear all pins. */
export function __resetForTesting(): void {
  pins.clear()
}
