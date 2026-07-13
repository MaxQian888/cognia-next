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
 * The six bundled children (agent-team, scheduler, workflow-trigger,
 * provider-routing, gateway, connector runtimes) render `null` (or are
 * childless pass-throughs) and only run mount effects, but they were
 * previously statically imported by `app/layout.tsx` — which pulled their
 * subsystem graphs into the eager module graph the dev server must compile
 * before it can render *any* route. That synchronous graph is a primary
 * driver of `pnpm dev` cold-start time and memory.
 *
 * The bundle is ONE dynamic chunk (`deferred-boot-initializers-impl.tsx`
 * statically imports all six) so the children mount in document order within
 * a single commit — RoutingRuntimeInitializer's mount-before-GatewayProvider
 * constraint stays deterministic, unlike six sibling `dynamic()` calls that
 * would commit in chunk-resolution order.
 *
 * Unlike `desktop-only-initializers.tsx` these are NOT platform-gated — they
 * must boot on web, Tauri, and Capacitor alike — so the only gates are the
 * hydration probe (export-safe `ssr: false`) and the pet-window skip below.
 * `next build` still emits the chunk into `out/`, and all three shells load
 * it right after hydration, so runtime behavior is unchanged; the work just
 * leaves the first-paint critical path.
 */
const DeferredBootInitializersImpl = dynamic(
  () => import("./deferred-boot-initializers-impl").then((m) => m.DeferredBootInitializersImpl),
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

  return <DeferredBootInitializersImpl />
}

export default DeferredBootInitializers
