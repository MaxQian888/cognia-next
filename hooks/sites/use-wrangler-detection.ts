"use client"

/**
 * Wrangler discovery for the console, split into a cheap probe and an expensive
 * approval.
 *
 * `ensureWranglerApproved` does two things: it resolves the binary through
 * `detect_binary` (cheap, natively cached), and it SHA-256s that binary's bytes
 * to record them in the Sites tool ledger (expensive — wrangler is tens of
 * megabytes). The console used to run both on every mount, unconditionally:
 * with no Site selected, on a shell that cannot upload at all, and for a user
 * who only came to read the operation journal.
 *
 * Here the probe runs only when the caller says the publish surface is showing
 * on a host that could act, and the hash is deferred to the moment an upload
 * actually needs the ledger entry — memoized per resolved path, so a session
 * that uploads ten versions hashes once.
 */
import { useCallback, useEffect, useRef, useState } from "react"

import {
  detectWranglerBinary,
  ensureWranglerApproved,
  type WranglerDetection,
} from "@/lib/sites/wrangler-detect"

export interface WranglerDetectionDeps {
  detect: typeof detectWranglerBinary
  approve: typeof ensureWranglerApproved
}

export interface WranglerController {
  /** null until the first probe resolves, or while disabled. */
  detection: WranglerDetection | null
  /**
   * Resolve and approve the binary, hashing it at most once per path per
   * session. Upload calls this; nothing else should.
   */
  ensureApproved: () => Promise<WranglerDetection>
  /** Re-probe after the user installs wrangler, busting the native cache. */
  redetect: () => Promise<WranglerDetection>
}

const NOT_FOUND: WranglerDetection = { path: null, version: null, ready: false }

/**
 * @param enabled false on a host that cannot upload, or before the publish
 *   surface is showing — the probe is skipped entirely rather than run and
 *   discarded.
 */
export function useWranglerDetection(
  enabled: boolean,
  dependencies?: Partial<WranglerDetectionDeps>
): WranglerController {
  // Captured once: injected dependencies are a test seam, never reactive input.
  const depsRef = useRef<WranglerDetectionDeps>({
    detect: detectWranglerBinary,
    approve: ensureWranglerApproved,
    ...dependencies,
  })
  const [detection, setDetection] = useState<WranglerDetection | null>(null)
  const approvedPath = useRef<string | null>(null)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    depsRef.current
      .detect()
      .then((result) => {
        if (!cancelled) setDetection(result)
      })
      .catch(() => {
        if (!cancelled) setDetection(NOT_FOUND)
      })
    return () => {
      cancelled = true
    }
  }, [enabled])

  const ensureApproved = useCallback(async (): Promise<WranglerDetection> => {
    // Already hashed this exact path this session — the ledger entry stands.
    if (detection?.path && approvedPath.current === detection.path) return detection
    const result = await depsRef.current.approve()
    approvedPath.current = result.path
    setDetection(result)
    return result
  }, [detection])

  const redetect = useCallback(async (): Promise<WranglerDetection> => {
    const { redetectWranglerBinary } = await import("@/lib/sites/wrangler-detect")
    const result = await redetectWranglerBinary()
    approvedPath.current = result.path
    setDetection(result)
    return result
  }, [])

  return { detection, ensureApproved, redetect }
}
