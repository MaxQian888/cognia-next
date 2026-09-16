"use client"

/**
 * Inbound LLM gateway runtime bridge (desktop only).
 *
 * Two jobs while mounted:
 *   1. Publish the routing + credential snapshot into the Rust gateway —
 *      once on mount and again (debounced) whenever the relevant settings
 *      change, plus a slow periodic refresh so a long-lived session keeps
 *      the gateway's view fresh. The gateway serves window-closed off the
 *      last-pushed snapshot.
 *   2. Forward `gateway://request-outcome` events into the shared provider
 *      telemetry sink so inbound traffic trains the same health / breaker /
 *      cost stores the chat plane reads.
 *
 * No-op outside Tauri (web / mobile have no HTTP listener).
 */

import { useCallback, useEffect, useRef } from "react"
import type { AppSettings } from "@cognia/agent-config-types"

import { isTauri, transport } from "@/lib/tauri"
import { gatewayDecisionResponse, gatewayGetStatus, gatewayPushSnapshot } from "@/lib/tauri/gateway"
import { buildEnrichedGatewaySnapshot } from "@/lib/gateway/snapshot-publisher"
import { forwardGatewayOutcome } from "@/lib/gateway/telemetry-forwarder"
import { resolveGatewayDecision, type GatewayDecideRequest } from "@/lib/gateway/decide"
import { subscribeSubscriptionChanged } from "@/lib/subscription/core/subscription-events"
import { useAccountStore } from "@/stores/account/account-store"
import { loggers } from "@cognia/logging"
import { appendGatewayRequestLog } from "@/lib/db/gateway-request-log"
import { useSettingsStore } from "@/stores/settings"
import {
  GATEWAY_DECIDE_EVENT,
  GATEWAY_REQUEST_LOG_EVENT,
  GATEWAY_REQUEST_OUTCOME_EVENT,
  GATEWAY_SNAPSHOT_INVALIDATED_EVENT,
  type GatewayAccountScope,
  type GatewayRequestLogRow,
  type GatewayRequestOutcome,
} from "@/types/gateway"

/** Slow periodic re-push so a multi-hour session never serves a stale snapshot. */
const PERIODIC_PUSH_MS = 5 * 60 * 1000
/** Coalesce bursts of settings writes into one push. */
const DEBOUNCE_MS = 1500

function routingSliceKey(settings: AppSettings | null | undefined): string {
  return JSON.stringify({
    d: settings?.defaultProvider,
    p: settings?.providerSettings,
    c: settings?.customProviders,
    m: settings?.modelMappings,
    r: settings?.routingConfig,
    a: settings?.defaultAccountIds,
    legacyAccount: settings?.defaultAccountId,
    // The two Router + Fusion gateway switches ride on the snapshot (ADR-0188
    // B2). Without them here, turning a gateway lane on or off would reach the
    // gateway only on the next periodic push.
    rf: settings?.routerFusion
      ? { e: settings.routerFusion.enabled, s: settings.routerFusion.surfaces }
      : undefined,
  })
}

export function GatewayProvider() {
  const settings = useSettingsStore((s) => s.settings)
  const unlockedAccountId = useAccountStore((s) => s.unlockedAccountId)
  const sliceKey = routingSliceKey(settings)
  const publicationScope = useRef<(GatewayAccountScope & { accountRequired: boolean }) | null>(null)
  const acceptsEvent = useCallback((event: GatewayAccountScope) => {
    const scope = publicationScope.current
    if (!scope || scope.ownerAccountId !== useAccountStore.getState().unlockedAccountId)
      return false
    return (
      !scope.accountRequired ||
      (event.ownerAccountId === scope.ownerAccountId &&
        event.accountGeneration === scope.accountGeneration)
    )
  }, [])

  // Snapshot publishing.
  useEffect(() => {
    if (!isTauri() || !unlockedAccountId) return
    let cancelled = false
    let revision = 0

    const push = async () => {
      const requestRevision = ++revision
      const stale = () =>
        cancelled ||
        requestRevision !== revision ||
        useAccountStore.getState().unlockedAccountId !== unlockedAccountId
      try {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          if (stale()) return
          // Capture host ownership BEFORE reading credentials. Never stamp a
          // completed projection with a newer account generation.
          const status = await gatewayGetStatus()
          if (stale() || (status.accountRequired && status.ownerAccountId !== unlockedAccountId))
            return
          const live = useSettingsStore.getState().settings
          if (!live) return
          const context = {
            ownerAccountId: unlockedAccountId,
            accountGeneration: status.accountGeneration,
          }
          publicationScope.current = {
            ...context,
            accountRequired: status.accountRequired ?? false,
          }
          const projectionKey = routingSliceKey(live)
          const { loadSnapshotProfileMeta } = await import("@/lib/gateway/snapshot-publisher")
          const profileMeta = await loadSnapshotProfileMeta()
          const snapshot = await buildEnrichedGatewaySnapshot(live, Date.now(), profileMeta)
          if (stale()) return
          if (routingSliceKey(useSettingsStore.getState().settings) !== projectionKey) {
            void push()
            return
          }
          const result = await gatewayPushSnapshot(snapshot, context)
          if (!result || result.accepted) return
          // A retry rebuilds ALL inputs, including vault credentials, against
          // freshly captured ownership and profile metadata.
          if (attempt === 1)
            loggers.app.warn("Gateway snapshot was rejected", { reason: result.reason })
        }
      } catch {
        if (!stale()) loggers.app.warn("Gateway snapshot publication failed")
      }
    }

    // Prepublish even before the first access key is created, so starting the
    // listener does not wait for the periodic refresh to acquire upstreams.
    const debounce = setTimeout(() => void push(), DEBOUNCE_MS)
    const interval = setInterval(() => void push(), PERIODIC_PUSH_MS)
    const unsubscribeSubscription = subscribeSubscriptionChanged(() => void push())
    const unsubscribeInvalidation = transport.subscribe(
      GATEWAY_SNAPSHOT_INVALIDATED_EVENT,
      () => void push()
    )

    return () => {
      cancelled = true
      publicationScope.current = null
      clearTimeout(debounce)
      clearInterval(interval)
      unsubscribeSubscription()
      unsubscribeInvalidation()
    }
  }, [sliceKey, unlockedAccountId])

  // Telemetry forwarding.
  useEffect(() => {
    if (!isTauri()) return
    const unsubscribe = transport.subscribe<GatewayRequestOutcome>(
      GATEWAY_REQUEST_OUTCOME_EVENT,
      (payload) => {
        if (!acceptsEvent(payload)) return
        try {
          forwardGatewayOutcome(payload)
        } catch {
          // Telemetry must never break on a malformed event.
        }
      }
    )
    return unsubscribe
  }, [acceptsEvent])

  // Durable request log: persist every gateway request row into Dexie so the
  // Settings "Logs" view survives a restart (the newapi Logs page equivalent).
  useEffect(() => {
    if (!isTauri()) return
    const unsubscribe = transport.subscribe<GatewayRequestLogRow>(
      GATEWAY_REQUEST_LOG_EVENT,
      (row) => {
        if (!acceptsEvent(row)) return
        void appendGatewayRequestLog(row).catch(() => {
          // A logging failure must never break the gateway.
        })
      }
    )
    return unsubscribe
  }, [acceptsEvent])

  // Live routing decisions: the gateway asks per-request; run the full engine
  // and reply. The Rust side caps the wait, so a slow/failed reply degrades to
  // the snapshot — we just answer best-effort.
  useEffect(() => {
    if (!isTauri()) return
    const unsubscribe = transport.subscribe<GatewayDecideRequest>(GATEWAY_DECIDE_EVENT, (req) => {
      if (!acceptsEvent(req)) return
      void (async () => {
        let entries: { providerId: string; modelId: string }[] = []
        try {
          const live = useSettingsStore.getState().settings
          if (live) {
            const { buildRoutingEngine, buildRoutingEngineDeps } =
              await import("@cognia/provider-routing/build-preview-engine")
            // The renderer's in-flight counter is written only by the chat
            // plane, so fold in the gateway's own per-provider tally (W1.2b) —
            // otherwise `least-busy` reads 0 for every provider and a
            // concurrent burst all lands on the same deployment.
            const base = buildRoutingEngineDeps(live)
            const engine = buildRoutingEngine(live, {
              getInFlight: (id) => (base.getInFlight?.(id) ?? 0) + (req.inFlight?.[id] ?? 0),
            })
            entries = await resolveGatewayDecision(
              req,
              engine,
              undefined,
              live.autoRouting?.dataPolicy
            )
          }
        } catch {
          entries = [] // any failure → empty = gateway uses its snapshot
        }
        if (acceptsEvent(req)) await gatewayDecisionResponse(req.requestId, entries).catch(() => {})
      })()
    })
    return unsubscribe
  }, [acceptsEvent])

  return null
}

export default GatewayProvider
