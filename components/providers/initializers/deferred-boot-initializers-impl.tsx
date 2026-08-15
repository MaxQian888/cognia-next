"use client"

import { useEffect } from "react"

import { ProviderCoreRuntimeInitializer } from "./provider-core-runtime-initializer"
import { RoutingRuntimeInitializer } from "./routing-runtime-initializer"
import { RemoteNotificationInitializer } from "./remote-notification-initializer"
import { GatewayProvider } from "@/components/providers/gateway-provider"
import { markBootCapabilityReady } from "@/lib/boot/capabilities"
import { recoverStaleDirectChatExecutionRuns } from "@/lib/execution/direct-chat-run"
import { startRendererWorkOutbox } from "@/lib/work-submission/bootstrap"

/**
 * The core-chat capability chunk (ADR-0068 C3). Its initializers mount in
 * document order within one commit. That determinism is load-bearing for two
 * pairs:
 * RoutingRuntimeInitializer must mount BEFORE GatewayProvider (it reconnects
 * the routing-engine adapters the gateway's decide-path reads), and
 * ProviderCoreRuntimeInitializer must mount BEFORE both (it installs the
 * proxy-fetch adapter every provider-core network call reads; without it they
 * fall back to a bare `fetch` the packaged shell's CSP blocks).
 *
 * Mount order preserves `app/layout.tsx`'s previous document order.
 */
export function DeferredBootInitializersImpl() {
  useEffect(() => {
    markBootCapabilityReady("core-chat")
    void recoverStaleDirectChatExecutionRuns()
    // Work stranded by a crash is picked up here (ADR-0123). A no-op while the
    // feature flag is off, so mounting it is safe ahead of the rollout.
    return startRendererWorkOutbox()
  }, [])

  return (
    <>
      <ProviderCoreRuntimeInitializer />
      <RoutingRuntimeInitializer />
      <RemoteNotificationInitializer />
      <GatewayProvider />
    </>
  )
}

export default DeferredBootInitializersImpl
