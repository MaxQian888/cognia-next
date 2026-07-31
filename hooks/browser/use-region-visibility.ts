"use client"

import { type RefObject, useEffect, useState } from "react"

const MODAL_OVERLAY_SLOTS = [
  "alert-dialog-overlay",
  "dialog-overlay",
  "drawer-overlay",
  "sheet-overlay",
]
const GENERIC_MODAL_SELECTOR =
  'dialog[open],[role="dialog"][aria-modal="true"],[role="alertdialog"][aria-modal="true"]'

const FLOATING_OVERLAY_SLOTS = [
  "combobox-content",
  "context-menu-content",
  "context-menu-sub-content",
  "dropdown-menu-content",
  "dropdown-menu-sub-content",
  "hover-card-content",
  "menubar-content",
  "menubar-sub-content",
  "navigation-menu-content",
  "popover-content",
  "select-content",
  "tooltip-content",
]

const MODAL_OVERLAY_SELECTOR = `${MODAL_OVERLAY_SLOTS.map(
  (slot) => `[data-slot="${slot}"]:not([data-state="closed"])`
).join(",")},${GENERIC_MODAL_SELECTOR}`

const FLOATING_OVERLAY_SELECTOR = FLOATING_OVERLAY_SLOTS.map(
  (slot) => `[data-slot="${slot}"]:not([data-state="closed"])`
).join(",")

const OBSERVED_OVERLAY_SLOT_SELECTOR = [...MODAL_OVERLAY_SLOTS, ...FLOATING_OVERLAY_SLOTS]
  .map((slot) => `[data-slot="${slot}"]`)
  .join(",")

const OBSERVED_OVERLAY_SELECTOR = `${MODAL_OVERLAY_SELECTOR},${FLOATING_OVERLAY_SELECTOR}`

function rectsOverlap(a: DOMRect, b: DOMRect): boolean {
  if (a.width <= 0 || a.height <= 0 || b.width <= 0 || b.height <= 0) return false
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
}

function containsObservedOverlay(node: Node): boolean {
  return (
    node instanceof Element &&
    (node.matches(OBSERVED_OVERLAY_SELECTOR) ||
      node.querySelector(OBSERVED_OVERLAY_SELECTOR) !== null)
  )
}

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
 *    means an overlay is on top. Their explicit overlay elements are also
 *    watched because not every Radix composition marks the region's ancestor.
 *  - **covered by a floating portal** → Tooltip and Select are intentionally
 *    non-modal, as are Popover and the menu primitives, so they do not mark the
 *    app inert. Their portal rect must be compared with the reserved region;
 *    otherwise the native webview paints above the popup and makes it look as
 *    though it instantly closed.
 */
export function useRegionVisibility(ref: RefObject<HTMLElement | null>): boolean {
  const [visible, setVisible] = useState(true)

  useEffect(() => {
    const el = ref.current
    if (!el) return

    let onScreen = true
    const coveredByModalOverlay = () => document.querySelector(MODAL_OVERLAY_SELECTOR) !== null
    const coveredByFloatingOverlay = () => {
      const regionRect = el.getBoundingClientRect()
      return Array.from(document.querySelectorAll<HTMLElement>(FLOATING_OVERLAY_SELECTOR)).some(
        (overlay) => rectsOverlap(regionRect, overlay.getBoundingClientRect())
      )
    }
    const occluded = () =>
      !!el.closest('[aria-hidden="true"],[inert]') ||
      coveredByModalOverlay() ||
      coveredByFloatingOverlay()
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

    const mo =
      typeof MutationObserver !== "undefined"
        ? new MutationObserver((records) => {
            const affectsOcclusion = records.some((record) => {
              if (record.type === "childList") {
                return [...record.addedNodes, ...record.removedNodes].some(containsObservedOverlay)
              }
              if (record.attributeName === "aria-hidden" || record.attributeName === "inert") {
                return true
              }
              if (
                record.attributeName === "open" ||
                record.attributeName === "role" ||
                record.attributeName === "aria-modal"
              ) {
                return true
              }
              if (record.attributeName === "data-state" || record.attributeName === "style") {
                return (
                  record.target instanceof Element &&
                  record.target.matches(OBSERVED_OVERLAY_SLOT_SELECTOR)
                )
              }
              return containsObservedOverlay(record.target)
            })
            if (affectsOcclusion) evaluate()
          })
        : null
    mo?.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: [
        "aria-hidden",
        "aria-modal",
        "data-state",
        "inert",
        "open",
        "role",
        "style",
      ],
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
