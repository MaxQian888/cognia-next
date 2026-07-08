"use client"

import { type RefObject, useEffect, useState } from "react"

/**
 * Whether a reserved region is genuinely visible on screen.
 *
 * The native embedded webview floats above the React layer and cannot be
 * clipped by CSS (see `src-tauri/src/browser/embedded.rs`), so it must be
 * parked off-screen the moment its region stops being visible — otherwise the
 * always-on-top webview keeps covering whatever is now on screen and eats all
 * input, which reads as the app "freezing". This hook watches the three ways a
 * region stops being visible without unmounting:
 *
 *  - **scrolled off / collapsed / route hidden** → `IntersectionObserver`
 *    (occlusion by *layout*).
 *  - **window backgrounded / minimized** → `document.visibilityState`.
 *  - **covered by a modal** → Radix Dialog/Sheet/command-palette mark the rest
 *    of the app `aria-hidden="true"` / `inert` when open, so an ancestor match
 *    means an overlay is on top. `IntersectionObserver` can't detect this
 *    (occlusion by a *sibling* element), which is exactly the freeze case.
 */
export function useRegionVisibility(ref: RefObject<HTMLElement | null>): boolean {
  const [visible, setVisible] = useState(true)

  useEffect(() => {
    const el = ref.current
    if (!el) return

    let onScreen = true
    const occluded = () => !!el.closest('[aria-hidden="true"],[inert]')
    const windowVisible = () =>
      typeof document === "undefined" || document.visibilityState !== "hidden"
    const evaluate = () => setVisible(onScreen && windowVisible() && !occluded())

    let io: IntersectionObserver | null = null
    if (typeof IntersectionObserver !== "undefined") {
      io = new IntersectionObserver(
        (entries) => {
          const entry = entries[entries.length - 1]
          if (entry) onScreen = entry.isIntersecting && entry.intersectionRatio > 0
          evaluate()
        },
        { threshold: 0 }
      )
      io.observe(el)
    }

    const mo = typeof MutationObserver !== "undefined" ? new MutationObserver(evaluate) : null
    mo?.observe(document.body, {
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-hidden", "inert"],
    })

    document.addEventListener("visibilitychange", evaluate)

    evaluate()

    return () => {
      io?.disconnect()
      mo?.disconnect()
      document.removeEventListener("visibilitychange", evaluate)
    }
  }, [ref])

  return visible
}
