"use client"

/**
 * Preview-session state for one Site, durable across remounts.
 *
 * `lib/sites/preview.ts` tracks live previews in a module-level map, so the
 * publish flow used to forget a running preview the moment the user navigated
 * away and back: the step fell back to "not started" and the Stop button
 * disappeared while the dev server kept running. On mount this re-adopts the
 * session from the terminal store before deciding the step is idle.
 */
import { useCallback, useEffect, useRef, useState } from "react"

import { resumeSitePreviewSession } from "@/lib/sites/preview"

export interface SitePreviewSessionDeps {
  /**
   * Resolves the Site's live preview. Already returns the tracked session
   * immediately when the module map still holds one, so there is no separate
   * synchronous peek to make render impure.
   */
  resume: typeof resumeSitePreviewSession
}

export interface SitePreviewSessionController {
  /** Preview origin when one is running, else null. */
  url: string | null
  /** False until the resume attempt settles — the step stays neutral until then. */
  resolved: boolean
  /** Record the URL of a preview this session just started, or null after stop. */
  adopt: (url: string | null) => void
}

export function useSitePreviewSession(
  siteId: string | null,
  dependencies?: Partial<SitePreviewSessionDeps>
): SitePreviewSessionController {
  // Captured once, on purpose: these are a test seam, not reactive input. An
  // inline object literal from a caller must never restart the resume effect.
  const depsRef = useRef<SitePreviewSessionDeps>({
    resume: resumeSitePreviewSession,
    ...dependencies,
  })

  // Keyed by Site rather than stored as two flags, so "resolved" is derived
  // from whether the answer we hold belongs to the Site being asked about.
  // Nothing has to be reset in an effect when the selection changes.
  const [answer, setAnswer] = useState<{ siteId: string | null; url: string | null }>({
    siteId: null,
    url: null,
  })

  const resolved = answer.siteId === siteId
  const url = resolved ? answer.url : null

  useEffect(() => {
    if (!siteId) return
    let cancelled = false
    void depsRef.current
      .resume(siteId)
      .then((session) => {
        if (!cancelled) setAnswer({ siteId, url: session?.url ?? null })
      })
      .catch(() => {
        if (!cancelled) setAnswer({ siteId, url: null })
      })
    return () => {
      cancelled = true
    }
  }, [siteId])

  const adopt = useCallback(
    (next: string | null) => {
      setAnswer({ siteId, url: next })
    },
    [siteId]
  )

  return { url, resolved, adopt }
}
