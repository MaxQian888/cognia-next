"use client"

import { AgentTeamRuntimeInitializer } from "./agent-team-runtime-initializer"
import { SchedulerInitializer } from "@/components/scheduler/scheduler-initializer"
import { WorkflowRuntimeProvider } from "@/components/providers/workflow-runtime-provider"
import { RoutingRuntimeInitializer } from "./routing-runtime-initializer"
import { GatewayProvider } from "@/components/providers/gateway-provider"
import { ConnectorBusProvider } from "@/components/connectors/connector-bus-provider"

/**
 * The deferred boot bundle's SINGLE chunk graph (ADR-0068 C3). All six
 * initializers are statically imported here — one `dynamic()` boundary in
 * `deferred-boot-initializers.tsx` loads this module, so the children mount
 * in document order within one commit, exactly like the pre-deferral static
 * layout. That determinism is load-bearing for one pair:
 * RoutingRuntimeInitializer must mount BEFORE GatewayProvider (it reconnects
 * the routing-engine adapters the gateway's decide-path reads). Six sibling
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
      <SchedulerInitializer />
      <WorkflowRuntimeProvider />
      <RoutingRuntimeInitializer />
      <GatewayProvider />
      <ConnectorBusProvider />
    </>
  )
}

export default DeferredBootInitializersImpl
