"use client"

import { useEffect, useRef, useState } from "react"
import { getPetCursorPosition } from "@/lib/tauri/pet-window"
import { getPetSkinRuntime } from "@/lib/pet/skin-runtime"
import type { PetLookTarget } from "@/types/pet"

export interface PetLookBounds {
  left: number
  top: number
  width: number
  height: number
}

export interface UsePetLookTargetOptions {
  enabled: boolean
  /** Use the Tauri global cursor command instead of page-local pointer events. */
  native: boolean
  suspended?: boolean
  getBounds: () => PetLookBounds
}

const POLL_MS = 100
const STALE_MS = 2_000

function normalizeTarget(
  x: number,
  y: number,
  bounds: PetLookBounds,
  source: PetLookTarget["source"]
): PetLookTarget {
  const halfWidth = Math.max(1, bounds.width / 2)
  const halfHeight = Math.max(1, bounds.height / 2)
  return {
    x: Math.max(-1, Math.min(1, (x - (bounds.left + halfWidth)) / halfWidth)),
    y: Math.max(-1, Math.min(1, (y - (bounds.top + halfHeight)) / halfHeight)),
    updatedAt: Date.now(),
    source,
  }
}

/** Local-only gaze source with a hard 10 Hz native polling ceiling. */
export function usePetLookTarget(options: UsePetLookTargetOptions): PetLookTarget | null {
  const [target, setTarget] = useState<PetLookTarget | null>(null)
  const boundsRef = useRef(options.getBounds)
  useEffect(() => {
    boundsRef.current = options.getBounds
  }, [options.getBounds])

  useEffect(() => {
    if (!options.enabled || options.suspended) return
    const runtime = getPetSkinRuntime()
    let staleTimer: number | null = null
    let releaseStaleTimer: (() => void) | null = null
    const update = (x: number, y: number, source: PetLookTarget["source"]) => {
      setTarget(normalizeTarget(x, y, boundsRef.current(), source))
      if (staleTimer !== null) window.clearTimeout(staleTimer)
      releaseStaleTimer?.()
      releaseStaleTimer = runtime.track("timers")
      staleTimer = window.setTimeout(() => {
        releaseStaleTimer?.()
        releaseStaleTimer = null
        staleTimer = null
        setTarget(null)
      }, STALE_MS)
    }

    if (!options.native) {
      const onPointerMove = (event: PointerEvent) => update(event.clientX, event.clientY, "window")
      window.addEventListener("pointermove", onPointerMove)
      return () => {
        window.removeEventListener("pointermove", onPointerMove)
        if (staleTimer !== null) window.clearTimeout(staleTimer)
        releaseStaleTimer?.()
      }
    }

    let disposed = false
    let polling = false
    const poll = async () => {
      if (polling || disposed) return
      polling = true
      try {
        const cursor = await getPetCursorPosition()
        if (!disposed && cursor) update(cursor.x, cursor.y, "screen")
      } finally {
        polling = false
      }
    }
    void poll()
    const releasePollTimer = runtime.track("timers")
    const interval = window.setInterval(() => void poll(), POLL_MS)
    return () => {
      disposed = true
      window.clearInterval(interval)
      releasePollTimer()
      if (staleTimer !== null) window.clearTimeout(staleTimer)
      releaseStaleTimer?.()
    }
  }, [options.enabled, options.native, options.suspended])

  if (!options.enabled || options.suspended) return null
  return target
}
