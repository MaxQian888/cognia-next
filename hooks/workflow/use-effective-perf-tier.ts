"use client"

/**
 * Compose `userChoice + prefers-reduced-motion + nodeCount` into the
 * resolved tier + flag set consumed by every motion-bearing feature in the
 * workflow editor.
 *
 * Persistence side-effect lives here, not in the toolbar:
 *   - On mount: read `loadPerformanceTierPref()` from Dexie and push it
 *     into the store (so a freshly mounted canvas immediately reflects the
 *     previously saved tier).
 *   - `setUserChoice` writes through to Dexie *and* updates the store
 *     synchronously.
 *
 * The `prefers-reduced-motion` listener is wired with `useSyncExternalStore`
 * so a flip of the OS-level setting re-renders the editor in real time.
 */

import { useCallback, useEffect, useRef, useSyncExternalStore } from "react"
import { useShallow } from "zustand/react/shallow"
import type { EditorStore, EditorState } from "@/lib/workflow/editor/store"
import {
  flagsForTier,
  resolveEffectiveTier,
  type EffectivePerfFlags,
  type PerformanceTier,
  type ResolvedPerformanceTier,
} from "@/lib/workflow/editor/performance-tier"
import {
  loadPerformanceTierPref,
  savePerformanceTierPref,
} from "@/lib/workflow/editor/performance-tier-prefs"

export interface EffectivePerfTier {
  /** Resolved tier after auto inference. Never `"auto"`. */
  effective: ResolvedPerformanceTier
  /** Boolean flag set the rest of the editor consumes. */
  flags: EffectivePerfFlags
  /** The user's choice as stored. Defaults to `"auto"`. */
  userChoice: PerformanceTier
  /** Update the user's choice and persist it to Dexie. */
  setUserChoice: (tier: PerformanceTier) => void
}

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)"

function subscribePrefersReducedMotion(notify: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) {
    return () => undefined
  }
  const mql = window.matchMedia(REDUCED_MOTION_QUERY)
  // Some test environments expose a partial `MediaQueryList` without
  // `addEventListener`; fall back to the legacy `addListener` if needed.
  if (typeof mql.addEventListener === "function") {
    mql.addEventListener("change", notify)
    return () => mql.removeEventListener("change", notify)
  }

  mql.addListener(notify)
  return () => {
    mql.removeListener(notify)
  }
}

function readPrefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false
  return window.matchMedia(REDUCED_MOTION_QUERY).matches
}

function serverPrefersReducedMotion(): boolean {
  return false
}

export function useEffectivePerfTier(store: EditorStore): EffectivePerfTier {
  const { userChoice, nodeCount, setPerformanceTier } = store(
    useShallow((s: EditorState) => ({
      userChoice: s.performanceTier,
      nodeCount: s.nodes.length,
      setPerformanceTier: s.setPerformanceTier,
    }))
  )

  // One-shot hydrate from Dexie. Guard against StrictMode double-invoke and
  // against re-running on store identity change (unmount → remount).
  const hydratedRef = useRef(false)
  useEffect(() => {
    if (hydratedRef.current) return
    hydratedRef.current = true
    let cancelled = false
    void loadPerformanceTierPref().then((stored) => {
      if (cancelled) return
      if (stored !== store.getState().performanceTier) {
        setPerformanceTier(stored)
      }
    })
    return () => {
      cancelled = true
    }
  }, [setPerformanceTier, store])

  const prefersReducedMotion = useSyncExternalStore(
    subscribePrefersReducedMotion,
    readPrefersReducedMotion,
    serverPrefersReducedMotion
  )

  const effective = resolveEffectiveTier(userChoice, {
    nodeCount,
    prefersReducedMotion,
  })
  const flags = flagsForTier(effective)

  const setUserChoice = useCallback(
    (tier: PerformanceTier) => {
      setPerformanceTier(tier)
      // Fire-and-forget; saveSettings serializes concurrent writes internally.
      void savePerformanceTierPref(tier)
    },
    [setPerformanceTier]
  )

  return { effective, flags, userChoice, setUserChoice }
}
