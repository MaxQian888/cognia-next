"use client"

import dynamic from "next/dynamic"
import { useSyncExternalStore } from "react"

import { isTauri } from "@/lib/native/utils"
import { getPetWindowRole, isSecondaryOverlayRole } from "@/lib/pet/window-role"

/**
 * Client-mount probe via `useSyncExternalStore` (not `useState` + effect, which
 * the repo's `react-hooks/set-state-in-effect` lint forbids). The server
 * snapshot is `false` and the client snapshot is `true`, so the first client
 * render matches the prerendered server output (`null`) and only flips to the
 * gated subtree after hydration — no divergence on the shared `out/` bundle.
 * Mirrors `DesktopOnlyInitializers`.
 */
const emptySubscribe = () => () => {}

function useIsClient(): boolean {
  return useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false
  )
}

// Both are `next/dynamic(ssr: false)` so the browser dev server (where the
// Tauri gate below is false) never fetches — and therefore never compiles —
// these desktop-only chunks. `next build` still emits them for the Tauri build.
const WindowShowInitializer = dynamic(
  () => import("./window-show-initializer").then((m) => m.WindowShowInitializer),
  { ssr: false }
)
const WebviewHeartbeatInitializer = dynamic(
  () => import("./webview-heartbeat-initializer").then((m) => m.WebviewHeartbeatInitializer),
  { ssr: false }
)

/**
 * Window-reveal + renderer-liveness initializers that MUST run *above* the
 * account gate.
 *
 * The Tauri main window is created hidden (`visible:false` in `tauri.conf.json`)
 * and revealed by `WindowShowInitializer` on the renderer's first paint. That
 * reveal — and the runtime white-screen-recovery heartbeat — used to live in
 * `DesktopOnlyInitializers`, which `app/layout.tsx` mounts *inside* `AccountGate`,
 * i.e. only once an account is unlocked. But on every desktop cold boot the gate
 * first renders the create-account or unlock form (`computeLocked` is `true`
 * whenever an account exists and none is unlocked yet) and never mounts its
 * `children`, so the reveal never fired: the window stayed black until the Rust
 * 8s force-show fallback (`lib.rs` setup logged "renderer never signaled first
 * paint" on *every* boot). That is the "black screen, lock screen never loads"
 * report.
 *
 * The lock/create screen is real, themed content worth showing immediately, so
 * these two run here — above the gate — keyed only on Tauri main-window. The
 * heartbeat consumes `whiteScreenRecovery` i18n, so this component must sit
 * inside `LocaleGate`.
 */
export function WindowLivenessInitializers() {
  const isClient = useIsClient()
  if (!isClient || !isTauri()) return null

  // Secondary overlay windows (pet sprite/popup, fleet island) load the same
  // root layout but are revealed by their own spawn path and must never boot
  // main-window concerns. `app/layout.tsx` already routes those windows to the
  // minimal `petShell` tree (so this component isn't mounted there); this guard
  // keeps the behaviour correct even if the mount point ever changes.
  if (isSecondaryOverlayRole(getPetWindowRole())) return null

  return (
    <>
      <WindowShowInitializer />
      <WebviewHeartbeatInitializer />
    </>
  )
}

export default WindowLivenessInitializers
