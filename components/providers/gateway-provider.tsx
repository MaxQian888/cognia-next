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

import { useEffect, useRef } from "react"

import { isTauri, transport } from "@/lib/tauri"
import { gatewayDecisionResponse, gatewayGetStatus, gatewayPushSnapshot } from "@/lib/tauri/gateway"
import {
  buildGatewaySnapshot,
  enrichSnapshotWithSubscriptionCreds,
} from "@/lib/gateway/snapshot-publisher"
import { forwardGatewayOutcome } from "@/lib/gateway/telemetry-forwarder"
import { resolveGatewayDecision, type GatewayDecideRequest } from "@/lib/gateway/decide"
import { resolveOpencodeVaultCredential } from "@/lib/subscription/opencode/chat-bridge"
import { OPENCODE_CHAT_PROVIDER_IDS } from "@/types/subscription/opencode"
import { appendGatewayRequestLog } from "@/lib/db/gateway-request-log"
import { useSettingsStore } from "@/stores/settings"
import {
  GATEWAY_DECIDE_EVENT,
  GATEWAY_REQUEST_LOG_EVENT,
  GATEWAY_REQUEST_OUTCOME_EVENT,
  type GatewayRequestLogRow,
  type GatewayRequestOutcome,
} from "@/types/gateway"

/** Slow periodic re-push so a multi-hour session never serves a stale snapshot. */
const PERIODIC_PUSH_MS = 5 * 60 * 1000
/** Coalesce bursts of settings writes into one push. */
const DEBOUNCE_MS = 1500

export function GatewayProvider() {
  const settings = useSettingsStore((s) => s.settings)
  // Re-publish only when the routing-relevant slice changes (not on every
  // unrelated settings write). Serialized so the effect dep is a primitive.
  const sliceKey = JSON.stringify({
    d: settings?.defaultProvider,
    p: settings?.providerSettings,
    c: settings?.customProviders,
    m: settings?.modelMappings,
  })
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Snapshot publishing.
  useEffect(() => {
    if (!isTauri()) return
    let cancelled = false

    const push = async () => {
      const live = useSettingsStore.getState().settings
      if (!live) return
      // Only push when the gateway actually has a token/listener — avoids
      // churn on installs that never enabled it.
      try {
        const status = await gatewayGetStatus()
        if (!status.hasToken) return
      } catch {
        return // not in a Tauri shell after all / command unavailable
      }
      const { loadSnapshotProfileMeta } = await import("@/lib/gateway/snapshot-publisher")
      const profileMeta = await loadSnapshotProfileMeta().catch(() => undefined)
      const base = buildGatewaySnapshot(
        {
          defaultProvider: live.defaultProvider,
          providerSettings: live.providerSettings,
          customProviders: live.customProviders,
          modelMappings: live.modelMappings,
        },
        Date.now(),
        profileMeta
      )
      // Fill in subscription-vault creds (opencode Zen/Go) the plain
      // provider-settings path can't supply, so subscription providers are
      // executable through the gateway too.
      const snapshot = await enrichSnapshotWithSubscriptionCreds(
        base,
        OPENCODE_CHAT_PROVIDER_IDS,
        resolveOpencodeVaultCredential
      ).catch(() => base)
      if (cancelled) return
      const result = await gatewayPushSnapshot(snapshot).catch(() => undefined)
      // R3: a rejected push means another authority moved the profileVersion
      // — reload the store projection and retry ONCE with fresh metadata.
      if (result && !result.accepted && !cancelled) {
        const freshMeta = await loadSnapshotProfileMeta().catch(() => undefined)
        const retry = buildGatewaySnapshot(
          {
            defaultProvider: live.defaultProvider,
            providerSettings: live.providerSettings,
            customProviders: live.customProviders,
            modelMappings: live.modelMappings,
          },
          Date.now(),
          freshMeta
        )
        await gatewayPushSnapshot(retry).catch(() => {})
      }
    }

    // Debounced push on slice change.
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => void push(), DEBOUNCE_MS)
    // Slow periodic refresh.
    const interval = setInterval(() => void push(), PERIODIC_PUSH_MS)

    return () => {
      cancelled = true
      if (debounceRef.current) clearTimeout(debounceRef.current)
      clearInterval(interval)
    }
  }, [sliceKey])

  // Telemetry forwarding.
  useEffect(() => {
    if (!isTauri()) return
    const unsubscribe = transport.subscribe<GatewayRequestOutcome>(
      GATEWAY_REQUEST_OUTCOME_EVENT,
      (payload) => {
        try {
          forwardGatewayOutcome(payload)
        } catch {
          // Telemetry must never break on a malformed event.
        }
      }
    )
    return unsubscribe
  }, [])

  // Durable request log: persist every gateway request row into Dexie so the
  // Settings "Logs" view survives a restart (the newapi Logs page equivalent).
  useEffect(() => {
    if (!isTauri()) return
    const unsubscribe = transport.subscribe<GatewayRequestLogRow>(
      GATEWAY_REQUEST_LOG_EVENT,
      (row) => {
        void appendGatewayRequestLog(row).catch(() => {
          // A logging failure must never break the gateway.
        })
      }
    )
    return unsubscribe
  }, [])

  // Live routing decisions: the gateway asks per-request; run the full engine
  // and reply. The Rust side caps the wait, so a slow/failed reply degrades to
  // the snapshot — we just answer best-effort.
  useEffect(() => {
    if (!isTauri()) return
    const unsubscribe = transport.subscribe<GatewayDecideRequest>(GATEWAY_DECIDE_EVENT, (req) => {
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
            entries = resolveGatewayDecision(req, engine)
          }
        } catch {
          entries = [] // any failure → empty = gateway uses its snapshot
        }
        await gatewayDecisionResponse(req.requestId, entries).catch(() => {})
      })()
    })
    return unsubscribe
  }, [])

  return null
}

export default GatewayProvider
