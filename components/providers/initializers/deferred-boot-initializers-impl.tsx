"use client"

import { useEffect } from "react"

import { CodeAdoptionTrackerInitializer } from "./code-adoption-tracker-initializer"
import { DesktopNetworkRuntimeInitializer } from "./desktop-network-runtime-initializer"
import { ExecutionControlInitializer } from "./execution-control-initializer"
import { ProviderCoreRuntimeInitializer } from "./provider-core-runtime-initializer"
import { ProviderOAuthRefreshInitializer } from "./provider-oauth-refresh-initializer"
import { RoutingRuntimeInitializer } from "./routing-runtime-initializer"
import { SessionPowerInitializer } from "./session-power-initializer"
import { RemoteNotificationInitializer } from "./remote-notification-initializer"
import { UpdateCenterInitializer } from "./update-center-initializer"
import { GatewayProvider } from "@/components/providers/gateway-provider"
import { markBootCapabilityReady } from "@/lib/boot/capabilities"
import { ensurePlanStepRecovery } from "@/lib/agent/plan/step-recovery"
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
 * DesktopNetworkRuntimeInitializer solves that same problem for
 * `@cognia/web-search` and `@cognia/rag`, and heads the chain because a search
 * or a rerank can be issued by the very first turn this chunk enables.
 *
 * Mount order preserves `app/layout.tsx`'s previous document order.
 *
 * `ExecutionControlInitializer` is order-independent — it only registers an
 * in-memory dispatch table — so it sits last rather than inside that chain.
 */
export function DeferredBootInitializersImpl() {
  useEffect(() => {
    markBootCapabilityReady("core-chat")
    void recoverStaleDirectChatExecutionRuns()
    // In-session plan steps whose turn died with the previous renderer load
    // halt on their step (retry / skip / mark done / cancel) at boot, not only
    // once a chat surface happens to mount the tracker dock. Once-per-load and
    // non-rejecting, so the dock's own call is a no-op after this one.
    void ensurePlanStepRecovery()
    // Work stranded by a crash is picked up here (ADR-0123). A no-op while the
    // feature flag is off, so mounting it is safe ahead of the rollout.
    return startRendererWorkOutbox()
  }, [])

  return (
    <>
      <DesktopNetworkRuntimeInitializer />
      <ProviderCoreRuntimeInitializer />
      {/* After ProviderCoreRuntimeInitializer: its renewals go through the
      same proxy-fetch adapter that initializer installs. */}
      <ProviderOAuthRefreshInitializer />
      <RoutingRuntimeInitializer />
      <RemoteNotificationInitializer />
      <GatewayProvider />
      {/* No ordering dependency: a registration-only dispatch table. */}
      <ExecutionControlInitializer />
      {/*
        Holds the screen for conversations whose power policy asks for it, for
        as long as they are running. Order-independent, and deliberately here
        rather than in a chat pane: the conversation that most needs the hold is
        the one the user has navigated away from.
      */}
      <SessionPowerInitializer />
      {/*
        Settling a turn's managed working copy is a chat obligation, not a
        workflow one. This subscriber is what calls `settleTaskWorkspaceTurn` on
        the status edge, and it used to live only in the workflow-automation
        chunk, which `/workflows`, `/scheduler`, `/goals` and `/a2ui` request
        and the chat route never does. So no chat turn released its run: the
        run stayed `running`, and the session's NEXT turn was refused for good
        with "pipeline workspace is already active". It is idempotent and
        subscribes once, so the workflow chunk keeping its own copy costs
        nothing.
      */}
      <CodeAdoptionTrackerInitializer />
      {/*
        Not desktop-gated: plugins, skills, character packs and the browser
        companion are updatable on hosts with no Tauri shell at all. Mounting
        it beside the desktop-only initializers instead would have left every
        other host with no update discovery whatsoever.
      */}
      <UpdateCenterInitializer />
    </>
  )
}

export default DeferredBootInitializersImpl
