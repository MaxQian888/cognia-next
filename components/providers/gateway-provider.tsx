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
import { gatewayGetStatus, gatewayPushSnapshot } from "@/lib/tauri/gateway"
import { buildGatewaySnapshot } from "@/lib/gateway/snapshot-publisher"
import { forwardGatewayOutcome } from "@/lib/gateway/telemetry-forwarder"
import { useSettingsStore } from "@/stores/settings"
import { GATEWAY_REQUEST_OUTCOME_EVENT, type GatewayRequestOutcome } from "@/types/gateway"

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
      const snapshot = buildGatewaySnapshot(
        {
          defaultProvider: live.defaultProvider,
          providerSettings: live.providerSettings,
          customProviders: live.customProviders,
          modelMappings: live.modelMappings,
        },
        Date.now()
      )
      if (!cancelled) await gatewayPushSnapshot(snapshot).catch(() => {})
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

  return null
}

export default GatewayProvider
