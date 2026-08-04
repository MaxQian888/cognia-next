/**
 * Mint the session-scoped route ticket a gateway-routed execution spec needs
 * (ADR-0090 Phase 2).
 *
 * Everything around this existed already and did nothing: the Rust commands,
 * the `gatewayAgentRouteTickets` flag, `sendSpecFromResolved`'s `gateway`
 * parameter, the settings panel that lists and revokes tickets, and the
 * sidecar's `validateRouteEnv` invariant. What was missing was an issuer — no
 * call site anywhere reached `gatewayMintRouteTicket`, so `route.kind` resolved
 * to `"gateway"` and then silently degraded to `direct` on the wire, and the
 * ticket list could never be anything but empty.
 *
 * The secret is returned ONCE and is never persisted: the caller stamps it into
 * `SendOptions.env.ANTHROPIC_API_KEY` alongside `ANTHROPIC_BASE_URL` (the
 * endpoint), which is exactly the shape `sidecar/dispatch/subprocess-env.mjs`
 * validates.
 */

import { isAgentExecutionFlagEnabled } from "@/lib/ai/agent/execution/feature-flags"
import { gatewayGetStatus, gatewayMintRouteTicket } from "@/lib/tauri/gateway"
import type { GatewayRoutingSnapshot } from "@/types/gateway"

export interface MintSessionTicketInput {
  sessionId: string
  parentSessionId?: string
  executionFingerprint: string
  /** The model the turn will ask for — decides which candidates are frozen. */
  model: string
  routePolicy: string
}

export interface MintedSessionTicket {
  /** OpenAI-compatible base URL of the local listener. */
  endpoint: string
  ticketId: string
  /** Shown once. Stamp into the subprocess env and drop. */
  secret: string
}

/**
 * Candidates the gateway can actually serve for `model`, ordered.
 *
 * Mint rejects any candidate the current snapshot cannot serve
 * (`TicketError::UnknownCandidate`), so this resolves against the same
 * snapshot the provider publishes rather than guessing. An alias contributes
 * its ordered entries; a bare / `provider:model` id falls back to whichever
 * enabled providers list it.
 */
export function candidatesForModel(
  snapshot: GatewayRoutingSnapshot,
  model: string
): Array<{ deploymentId: string; modelId: string }> {
  const deploymentFor = (providerId: string): string | undefined =>
    snapshot.providers.find((provider) => provider.id === providerId)?.deploymentId ?? providerId

  const alias = snapshot.aliases.find((entry) => entry.alias === model)
  if (alias) {
    return alias.entries.flatMap((entry) => {
      const deploymentId = deploymentFor(entry.providerId)
      return deploymentId ? [{ deploymentId, modelId: entry.modelId }] : []
    })
  }

  // `provider:model` pins one provider; a bare id may be served by several.
  const [maybeProvider, ...rest] = model.split(":")
  const bareModel = rest.length > 0 ? rest.join(":") : model
  return snapshot.providers.flatMap((provider) => {
    if (!provider.enabled) return []
    if (rest.length > 0 && provider.id !== maybeProvider) return []
    if (!provider.models.includes(bareModel)) return []
    return [{ deploymentId: provider.deploymentId ?? provider.id, modelId: bareModel }]
  })
}

/** `loopback` binds 127.0.0.1; `lan` still answers there, so both dial local. */
function endpointFor(port: number): string {
  return `http://127.0.0.1:${port}/v1`
}

/**
 * Returns `undefined` — never throws — when a ticket cannot be minted: the flag
 * is off, the listener is not running, the snapshot cannot serve the model, or
 * Rust refused. The caller then sends the `direct` wire shape, which is the
 * pre-existing behavior. Failing the whole turn over an optional route freeze
 * would be a worse trade.
 */
export async function mintSessionRouteTicket(
  input: MintSessionTicketInput
): Promise<MintedSessionTicket | undefined> {
  if (!isAgentExecutionFlagEnabled("gatewayAgentRouteTickets")) return undefined

  try {
    const status = await gatewayGetStatus()
    if (!status.running || status.boundPort === null) return undefined

    const { buildGatewaySnapshot, loadSnapshotProfileMeta } =
      await import("@/lib/gateway/snapshot-publisher")
    const { useSettingsStore } = await import("@/stores/settings")
    const live = useSettingsStore.getState().settings
    if (!live) return undefined

    const profileMeta = await loadSnapshotProfileMeta().catch(() => undefined)
    const snapshot = buildGatewaySnapshot(
      {
        defaultProvider: live.defaultProvider,
        providerSettings: live.providerSettings,
        customProviders: live.customProviders,
        modelMappings: live.modelMappings,
        routingConfig: live.routingConfig,
      },
      Date.now(),
      profileMeta
    )

    const candidates = candidatesForModel(snapshot, input.model)
    if (candidates.length === 0) return undefined

    const minted = await gatewayMintRouteTicket({
      sessionId: input.sessionId,
      ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
      executionFingerprint: input.executionFingerprint,
      candidates,
      // More than one candidate means failover is possible, so the ticket must
      // permit moving off the first credential; a single candidate stays stuck
      // to its own.
      credentialAffinity: candidates.length > 1 ? "sticky-with-failover" : "session-sticky",
      allowAuthFailover: candidates.length > 1,
      routePolicy: input.routePolicy,
    })

    return {
      endpoint: endpointFor(status.boundPort),
      ticketId: minted.ticket.ticketId,
      secret: minted.secret,
    }
  } catch {
    return undefined
  }
}
