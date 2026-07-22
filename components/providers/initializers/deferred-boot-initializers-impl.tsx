"use client"

import { AgentTeamRuntimeInitializer } from "./agent-team-runtime-initializer"
import { SchedulerInitializer } from "@/components/scheduler/scheduler-initializer"
import { WorkflowRuntimeProvider } from "@/components/providers/workflow-runtime-provider"
import { ProviderCoreRuntimeInitializer } from "./provider-core-runtime-initializer"
import { RoutingRuntimeInitializer } from "./routing-runtime-initializer"
import { GatewayProvider } from "@/components/providers/gateway-provider"
import { ConnectorBusProvider } from "@/components/connectors/connector-bus-provider"
import { CodeAdoptionTrackerInitializer } from "./code-adoption-tracker-initializer"
import { MemoryJobWorkerInitializer } from "./memory-job-worker-initializer"
import { A2UISurfacePersistenceInitializer } from "./a2ui-surface-persistence-initializer"

/**
 * The deferred boot bundle's SINGLE chunk graph (ADR-0068 C3). All
 * initializers are statically imported here — one `dynamic()` boundary in
 * `deferred-boot-initializers.tsx` loads this module, so the children mount
 * in document order within one commit, exactly like the pre-deferral static
 * layout. That determinism is load-bearing for two pairs:
 * RoutingRuntimeInitializer must mount BEFORE GatewayProvider (it reconnects
 * the routing-engine adapters the gateway's decide-path reads), and
 * ProviderCoreRuntimeInitializer must mount BEFORE both (it installs the
 * proxy-fetch adapter every provider-core network call reads; without it they
 * fall back to a bare `fetch` the packaged shell's CSP blocks). Seven sibling
 * `dynamic()` calls would commit in chunk-resolution order instead and
 * reintroduce the race.
 *
 * Mount order preserves `app/layout.tsx`'s previous document order.
 * ConnectorBusProvider is a childless pass-through here — a pure effect
 * mount; its former wrapper position in the layout tree carried no context.
 */
export function DeferredBootInitializersImpl() {
  return (
    <>
      <AgentTeamRuntimeInitializer />
      <CodeAdoptionTrackerInitializer />
      <MemoryJobWorkerInitializer />
      <A2UISurfacePersistenceInitializer />
      <SchedulerInitializer />
      <WorkflowRuntimeProvider />
      <ProviderCoreRuntimeInitializer />
      <RoutingRuntimeInitializer />
      <GatewayProvider />
      <ConnectorBusProvider />
    </>
  )
}

export default DeferredBootInitializersImpl
