"use client"

/**
 * Consumes the `?focus=<controlId>` URL param produced by the settings finder:
 * scrolls the matching `[data-setting-id="<controlId>"]` element into view,
 * pulses a highlight ring, then strips the param so a refresh / back-nav does
 * not re-trigger. Sections are code-split, so the element may mount a few
 * frames after navigation — hence the bounded retry.
 *
 * When no anchor exists for the id (a registered-but-unanchored control), the
 * finder still navigated to the right section; this hook simply clears the
 * param after the retry budget without highlighting. Honest degradation.
 */

import { useEffect } from "react"
import { useRouter, useSearchParams } from "next/navigation"

const HIGHLIGHT_CLASSES = ["ring-2", "ring-ring", "ring-offset-2", "rounded-md"]
const HIGHLIGHT_MS = 1800
const RETRY_MS = 60
const MAX_ATTEMPTS = 20

export function useSettingFocus(): void {
  const router = useRouter()
  const searchParams = useSearchParams()
  const focus = searchParams.get("focus")

  useEffect(() => {
    // Guard the selector against anything that isn't a plain control id.
    if (!focus || !/^[a-z0-9-]+$/i.test(focus)) return

    let cancelled = false
    let attempts = 0
    let timer: ReturnType<typeof setTimeout>

    const clearParam = () => {
      const next = new URLSearchParams(searchParams.toString())
      next.delete("focus")
      router.replace(`?${next.toString()}`, { scroll: false })
    }

    const tryFocus = () => {
      if (cancelled) return
      const el = document.querySelector<HTMLElement>(`[data-setting-id="${focus}"]`)
      if (el) {
        el.scrollIntoView?.({ behavior: "smooth", block: "center" })
        el.classList.add(...HIGHLIGHT_CLASSES)
        window.setTimeout(() => el.classList.remove(...HIGHLIGHT_CLASSES), HIGHLIGHT_MS)
        clearParam()
        return
      }
      attempts += 1
      if (attempts >= MAX_ATTEMPTS) {
        clearParam()
        return
      }
      timer = setTimeout(tryFocus, RETRY_MS)
    }

    timer = setTimeout(tryFocus, 0)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [focus, router, searchParams])
}
