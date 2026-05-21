"use client"

// Devtools-gate: returns whether the Plugin panel's "Devtools" left-nav
// section should render. Two ways to flip it on:
//
//   1. `process.env.NODE_ENV === "development"` — always on in dev builds.
//   2. `localStorage["plugins:devtools:enabled"] === "true"` — opt-in for
//      power users on production builds. Settings UI sets this flag via
//      the (future) Developer Mode toggle; for now it's editable via
//      DevTools console so the team can dogfood it without shipping a new
//      surface.
//
// SSR-safety: returns `false` on the first render (before the effect
// attaches the storage listener) so the server-rendered shell and the
// static-export HTML stay stable. The effect re-checks on mount and on the
// `storage` event so flipping the flag in another tab updates this tab
// without a reload.

import { useEffect, useState } from "react"

export const DEVTOOLS_GATE_STORAGE_KEY = "plugins:devtools:enabled"

function readStorageFlag(): boolean {
  if (typeof window === "undefined") return false
  try {
    return window.localStorage.getItem(DEVTOOLS_GATE_STORAGE_KEY) === "true"
  } catch {
    // localStorage can throw in privacy mode or sandboxed iframes — treat
    // those environments as gated-off.
    return false
  }
}

function isDevBuild(): boolean {
  return process.env.NODE_ENV === "development"
}

export function useDevtoolsGate(): boolean {
  const [enabled, setEnabled] = useState(false)

  useEffect(() => {
    const update = () => {
      setEnabled(isDevBuild() || readStorageFlag())
    }
    update()

    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === DEVTOOLS_GATE_STORAGE_KEY) {
        update()
      }
    }
    window.addEventListener("storage", onStorage)
    return () => window.removeEventListener("storage", onStorage)
  }, [])

  return enabled
}
