/**
 * Which route a pairing registration takes to the Host (ADR-0170): directly to
 * the invitation's `baseUrl`, or through the one-shot relay room it carries.
 *
 * Shared by the app's pair screen and `cognia-agent host login` (ADR-0224 A2),
 * so a phone, a desktop and the CLI all prefer the same path.
 */

import { fetchCompanionAuthConfig, type AuthFetcher } from "@/lib/tauri/companion-auth"
import type { PairPayload } from "@/lib/qr/pair-payload"

/**
 * How long a direct probe of the Host may take before the relay is used
 * instead. A reachable Host answers `/api/auth/config` in well under a second
 * on a LAN and in a second or two through a tunnel. A Host that is not
 * reachable on `baseUrl` would otherwise make the user wait out the
 * platform's own connect timeout, with an invitation ticking away.
 */
export const DIRECT_PAIR_PROBE_TIMEOUT_MS = 4_000

/** How the registration reached the Host. */
export type PairPath = "direct" | "relay"

export interface PairPathOptions {
  /**
   * Force a path. `undefined` (the default) probes the Host directly first
   * and falls back to the relay when the invitation carries one.
   */
  path?: PairPath
  /** Test injection of the direct probe. */
  probeDirect?: (payload: PairPayload, fetcher: AuthFetcher | undefined) => Promise<boolean>
}

/**
 * Direct first, relay second. Direct is preferred because it is the path every
 * later request takes on a LAN or tunnel, and because a Host that answers
 * directly proves `baseUrl` for the credential record. The relay is taken when
 * there is one and the Host does not answer within the probe window.
 */
export async function choosePairPath(
  payload: PairPayload,
  fetcher: AuthFetcher | undefined,
  options: PairPathOptions = {}
): Promise<PairPath> {
  if (options.path) return options.path
  if (!payload.relay) return "direct"
  const probe = options.probeDirect ?? probeDirectPairPath
  return (await probe(payload, fetcher)) ? "direct" : "relay"
}

/** Whether the Host the invitation names answers on its `baseUrl` in time. */
export async function probeDirectPairPath(
  payload: PairPayload,
  fetcher: AuthFetcher | undefined,
  timeoutMs: number = DIRECT_PAIR_PROBE_TIMEOUT_MS
): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const config = await fetchCompanionAuthConfig(
      payload.baseUrl,
      payload.fingerprint || undefined,
      fetcher,
      { signal: controller.signal }
    )
    return config.hostId === payload.hostId
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}
