"use client"

/**
 * `useLayoutEffect` that degrades to `useEffect` when there is no DOM.
 *
 * React warns when `useLayoutEffect` runs during server rendering, and this app
 * is a static export: every client component is prerendered at build time even
 * though it only ever runs in a browser afterwards. The guard was copied into
 * `use-element-width` and `use-element-axis-size` independently before this
 * existed; it lives here so the next measurement hook does not make a third.
 *
 * Reach for it whenever the effect must observe or correct layout *before the
 * browser paints* — measuring a box, or writing `scrollTop` to cancel a growth
 * in the same frame that painted it (ADR-0138). A plain `useEffect` runs after
 * paint, which is exactly the one-frame flicker those effects exist to avoid.
 */

import { useEffect, useLayoutEffect } from "react"

export const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect
