"use client"

import dynamic from "next/dynamic"
import { useSyncExternalStore } from "react"

import { getPetWindowRole, isSecondaryOverlayRole } from "@/lib/pet/window-role"

/**
 * Client-mount probe via `useSyncExternalStore` (not `useState` + effect, which
 * the repo's `react-hooks/set-state-in-effect` lint forbids). The server
 * snapshot is `false` and the client snapshot is `true`, so the first client
 * render matches the prerendered server output (`null`) and only flips to the
 * gated subtree after hydration — no divergence on the shared `out/` bundle.
 */
const emptySubscribe = () => () => {}

function useIsClient(): boolean {
  return useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false
  )
}

/**
 * Heavy boot initializers, deferred out of the root layout's synchronous
 * first-paint compile graph (ADR-0068 C3).
 *
 * Each child below renders `null` (or is a childless pass-through) and only
 * runs a mount effect, but they were previously statically imported by
 * `app/layout.tsx` — which pulled the workflow-runtime, gateway-routing,
 * connector, scheduler, and agent-team subsystem graphs into the eager module
 * graph the dev server must compile before it can render *any* route. That
 * synchronous graph is a primary driver of `pnpm dev` cold-start time and
 * memory.
 *
 * Unlike `desktop-only-initializers.tsx` these are NOT platform-gated — they
 * must boot on web, Tauri, and Capacitor alike — so the only gates are the
 * hydration probe (export-safe `ssr: false`) and the pet-window skip below.
 * `next build` still emits every chunk into `out/`, and all three shells load
 * them right after hydration, so runtime behavior is unchanged; the work just
 * leaves the first-paint critical path.
 *
 * Mount order preserves `app/layout.tsx`'s previous document order. The one
 * hard constraint: RoutingRuntimeInitializer must mount BEFORE
 * GatewayProvider, which builds routing engines from the reconnected stores.
 */
const AgentTeamRuntimeInitializer = dynamic(
  () => import("./agent-team-runtime-initializer").then((m) => m.AgentTeamRuntimeInitializer),
  { ssr: false }
)
// Deep import (not the `@/components/scheduler` barrel) so the deferred chunk
// carries only the initializer, not the scheduler UI surface.
const SchedulerInitializer = dynamic(
  () => import("@/components/scheduler/scheduler-initializer").then((m) => m.SchedulerInitializer),
  { ssr: false }
)
/* Boots the workflow trigger runtime: installs the Rust `workflow:trigger`
 * event bridge, seeds the chat/connector inbound trigger-match cache
 * (`initTriggerSubscriptions`), re-syncs every workflow's cron/webhook
 * registration to the Rust router on launch, and resumes in-flight runs after
 * a crash. Without this mount, every non-manual trigger and crash recovery is
 * dormant. No-op on web (Tauri calls no-op; the inbound cache still seeds). */
const WorkflowRuntimeProvider = dynamic(
  () =>
    import("@/components/providers/workflow-runtime-provider").then(
      (m) => m.WorkflowRuntimeProvider
    ),
  { ssr: false }
)
/* Reconnects the isolated provider-routing engine to the live
 * telemetry/settings stores (health, breaker, spend, rate, in-flight, session
 * affinity, difficulty + semantic routers). Without this, all
 * reliability/strategy routing silently degrades to priority order. Must
 * mount before GatewayProvider, which builds routing engines. */
const RoutingRuntimeInitializer = dynamic(
  () => import("./routing-runtime-initializer").then((m) => m.RoutingRuntimeInitializer),
  { ssr: false }
)
const GatewayProvider = dynamic(
  () => import("@/components/providers/gateway-provider").then((m) => m.GatewayProvider),
  { ssr: false }
)
/* Boots the shared connector runtime (scheduler executors → WS reap → adapter
 * boot loop → PII-gated route handler → outbound runner → sweeps). The
 * component is a childless pass-through here, so it acts as a pure effect
 * mount; its former wrapper position in the layout tree carried no context. */
const ConnectorBusProvider = dynamic(
  () =>
    import("@/components/connectors/connector-bus-provider").then((m) => m.ConnectorBusProvider),
  { ssr: false }
)

export function DeferredBootInitializers() {
  const isClient = useIsClient()
  if (!isClient) return null

  // The transparent desktop-pet windows (sprite overlay + click popup) load
  // this same root layout; every initializer bundled here is a main-window
  // boot concern (workflow/gateway/connector/scheduler/agent-team runtimes).
  // Running them in a pet window is wasted work — skip the whole bundle
  // there, same as desktop-only-initializers.tsx.
  const role = getPetWindowRole()
  if (isSecondaryOverlayRole(role)) return null

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

export default DeferredBootInitializers
