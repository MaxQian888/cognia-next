"use client"

import dynamic from "next/dynamic"
import { useSyncExternalStore } from "react"

import {
  getBootCapabilitySnapshot,
  isBootCapabilityRequested,
  markBootCapabilityFailed,
  subscribeBootCapabilities,
  type BootCapability,
} from "@/lib/boot/capabilities"
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
 * Optional subsystem graphs are split across capability-level dynamic chunks.
 * `eager` requests every chunk to preserve the previous startup behavior;
 * development-only `main` requests core chat first and mounts the other
 * groups when their route or background activation needs them. Ordering
 * constraints stay inside each capability group.
 *
 * Unlike `desktop-only-initializers.tsx` these are NOT platform-gated — they
 * must boot on web, Tauri, and Capacitor alike — so the only gates are the
 * hydration probe (export-safe `ssr: false`), capability request, and the
 * pet-window skip below. Production resolves to `eager`, and `next build`
 * still emits every chunk into `out/`.
 */
const DeferredBootInitializersImpl = dynamic(
  () =>
    import("./deferred-boot-initializers-impl")
      .then((m) => m.DeferredBootInitializersImpl)
      .catch((error) => failCapability("core-chat", error)),
  { ssr: false }
)
const WorkflowAutomationBootInitializers = dynamic(
  () =>
    import("./workflow-automation-boot-initializers")
      .then((m) => m.WorkflowAutomationBootInitializers)
      .catch((error) => failCapability("workflow-automation", error)),
  { ssr: false }
)
const IntegrationBootInitializers = dynamic(
  () =>
    import("./integration-boot-initializers")
      .then((m) => m.IntegrationBootInitializers)
      .catch((error) => failCapability("integrations", error)),
  { ssr: false }
)
const KnowledgeAgentBootInitializers = dynamic(
  () =>
    import("./knowledge-agent-boot-initializers")
      .then((m) => m.KnowledgeAgentBootInitializers)
      .catch((error) => failCapability("knowledge-agents", error)),
  { ssr: false }
)

function failCapability(capability: BootCapability, error: unknown): never {
  markBootCapabilityFailed(capability, error)
  throw error
}

function useCapabilityRequested(capability: BootCapability): boolean {
  useSyncExternalStore(
    subscribeBootCapabilities,
    getBootCapabilitySnapshot,
    getBootCapabilitySnapshot
  )
  return isBootCapabilityRequested(capability)
}

export function DeferredBootInitializers() {
  const isClient = useIsClient()
  const core = useCapabilityRequested("core-chat")
  const workflow = useCapabilityRequested("workflow-automation")
  const integrations = useCapabilityRequested("integrations")
  const knowledge = useCapabilityRequested("knowledge-agents")
  if (!isClient) return null

  // The transparent desktop-pet windows (sprite overlay + click popup) load
  // this same root layout; every initializer coordinated here is a main-window
  // boot concern (workflow/gateway/connector/scheduler/agent-team runtimes).
  // Running them in a pet window is wasted work — skip all capability groups
  // there, same as desktop-only-initializers.tsx.
  const role = getPetWindowRole()
  if (isSecondaryOverlayRole(role)) return null

  return (
    <>
      {core ? <DeferredBootInitializersImpl /> : null}
      {workflow ? <WorkflowAutomationBootInitializers /> : null}
      {integrations ? <IntegrationBootInitializers /> : null}
      {knowledge ? <KnowledgeAgentBootInitializers /> : null}
    </>
  )
}

export default DeferredBootInitializers
