"use client"

/**
 * "Can this device submit a crash report, and by which path?"
 *
 * Two surfaces need the answer — the `/logs` Crash reports consent panel and
 * the Settings connection card's automatic-submission switch — and both used
 * to ask `canSubmitDiagnostics()`, which is `isTauri()`. The phone has a
 * complete submission path through the Capacitor crash plugin, so every
 * mobile user was told submission "is available in the desktop app" while
 * the code to do it sat one branch away.
 *
 * The desktop answer is synchronous and known on the first render, so it never
 * flashes "unsupported". The mobile answer needs the plugin's capability probe,
 * so until it lands `checking` is true and `runtime` is null.
 */

import { useEffect, useMemo, useState } from "react"

import {
  canSubmitDiagnostics,
  resolveSubmissionRuntime,
  type DiagnosticSubmissionRuntime,
} from "@/lib/native/diagnostic-submit"

export interface DiagnosticSubmissionSupport {
  /** The path this device submits through, or null when it has none (yet). */
  runtime: DiagnosticSubmissionRuntime | null
  supported: boolean
  /** The asynchronous mobile probe has not answered yet. */
  checking: boolean
}

/** Seams for the tests; production passes nothing. */
export interface DiagnosticSubmissionSupportDeps {
  isDesktop?: () => boolean
  resolveRuntime?: () => Promise<DiagnosticSubmissionRuntime | null>
}

export function useDiagnosticSubmissionSupport(
  deps: DiagnosticSubmissionSupportDeps = {}
): DiagnosticSubmissionSupport {
  const desktop = (deps.isDesktop ?? canSubmitDiagnostics)()
  const resolveRuntime = deps.resolveRuntime
  const [probe, setProbe] = useState<{
    done: boolean
    runtime: DiagnosticSubmissionRuntime | null
  }>({ done: false, runtime: null })

  useEffect(() => {
    if (desktop) return
    let active = true
    // Every write lands in the async continuation, never in the effect body
    // (`react-hooks/set-state-in-effect`).
    void (resolveRuntime ?? (() => resolveSubmissionRuntime()))()
      .catch(() => null)
      .then((runtime) => {
        // Bail out on an unchanged answer: a caller passing a fresh
        // `resolveRuntime` per render re-runs this effect, and a new object
        // every time would turn that into a render loop.
        if (active) {
          setProbe((previous) =>
            previous.done && previous.runtime === runtime ? previous : { done: true, runtime }
          )
        }
      })
    return () => {
      active = false
    }
  }, [desktop, resolveRuntime])

  return useMemo(() => {
    if (desktop) return { runtime: "desktop", supported: true, checking: false }
    return { runtime: probe.runtime, supported: probe.runtime !== null, checking: !probe.done }
  }, [desktop, probe])
}
