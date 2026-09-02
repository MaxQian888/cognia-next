"use client"

/**
 * What the machine that will run an agent already has, keyed by preset id.
 *
 * The picker asks once, when it opens. Detection spawns catalogued `--version`
 * reads on the host, so re-asking on every render (or every keystroke in the
 * form beneath it) would fork a process tree per character. The cache lives in
 * `lib/ai/agent/external/installed-runtimes`, which is where `refresh` clears.
 *
 * `undefined` for a preset means "not asked, or nothing to ask", and callers
 * must render that as unknown. It is not a synonym for missing: telling a user
 * their CLI is absent because a Host had not finished handshaking is exactly
 * the failure this whole path exists to stop making.
 */

import { useCallback, useEffect, useMemo, useState } from "react"

import {
  detectInstalledRuntimes,
  type InstalledRuntime,
} from "@/lib/ai/agent/external/installed-runtimes"
import {
  externalAgentProcessPlaneScope,
  PROCESS_PLANE_COMMANDS,
  type ProcessPlaneUnavailableReason,
} from "@/lib/ai/agent/external/process-plane"
import { useExternalAgentProcessPlane } from "@/hooks/agent/use-external-agent-process-plane"
import { findRuntimeByPresetId } from "@/lib/ai/agent/external/runtime-catalog"

/** Stable identity so the memo below does not re-run on every render. */
const EMPTY: readonly InstalledRuntime[] = Object.freeze([])

export interface InstalledAgentRuntimes {
  /** True while the host is being asked. */
  loading: boolean
  /**
   * Why nothing is known, or `null` when the answer is simply the rows below.
   *
   * A plane reason when detection cannot be asked from here at all, and
   * `"failed"` when it was asked and did not answer. Those are different
   * things, and reporting the second as the plane's `"unsupported"` blamed a
   * Host that had in fact declared the operation.
   */
  unavailable: ProcessPlaneUnavailableReason | "failed" | null
  /** Everything the host reported, in catalog order. */
  runtimes: readonly InstalledRuntime[]
  /** What this preset launches, or `undefined` when nothing is known. */
  forPreset: (presetId: string) => InstalledRuntime | undefined
  /** Re-ask the host, e.g. after the user installs something. */
  refresh: () => void
}

export function useInstalledAgentRuntimes(enabled: boolean): InstalledAgentRuntimes {
  const [runtimes, setRuntimes] = useState<readonly InstalledRuntime[]>([])
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const [nonce, setNonce] = useState(0)

  // Subscribed, so a Host that finishes handshaking reaches the gate on its
  // own. Deriving it in render rather than in the effect still keeps the
  // effect to the one thing it is for (asking the host) with no cascading
  // setState behind it, but sampling it once meant the badges stayed blank
  // behind a "not finished reporting" line that nothing could clear.
  const plane = useExternalAgentProcessPlane(PROCESS_PLANE_COMMANDS.detect)
  const reachable = plane.ok
  const scope = externalAgentProcessPlaneScope()

  useEffect(() => {
    if (!enabled || !reachable) return
    let cancelled = false
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the pending flag for an async host read, with no render-time value to derive it from
    setLoading(true)
    detectInstalledRuntimes({ refresh: nonce > 0 })
      .then((detected) => {
        if (cancelled) return
        setRuntimes(detected)
        setFailed(false)
      })
      .catch(() => {
        // A failed detection is unknown, not empty. Leaving the previous rows
        // in place would claim a stale answer is current, so they are cleared
        // and the badge falls back to saying nothing.
        if (cancelled) return
        setRuntimes([])
        setFailed(true)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [enabled, nonce, reachable, scope])

  const unavailable = plane.ok ? (failed ? ("failed" as const) : null) : plane.reason
  const visible = reachable ? runtimes : EMPTY

  const byRuntimeId = useMemo(() => {
    const index = new Map<string, InstalledRuntime>()
    for (const runtime of visible) index.set(runtime.runtimeId, runtime)
    return index
  }, [visible])

  const forPreset = useCallback(
    (presetId: string) => {
      const entry = findRuntimeByPresetId(presetId)
      return entry ? byRuntimeId.get(entry.runtimeId) : undefined
    },
    [byRuntimeId]
  )

  const refresh = useCallback(() => setNonce((value) => value + 1), [])

  return { loading, unavailable, runtimes: visible, forPreset, refresh }
}
