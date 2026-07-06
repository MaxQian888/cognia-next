/**
 * Absolute terminal position of an Ink node, read from its Yoga layout.
 *
 * Ink's public `DOMElement` type doesn't surface the computed layout, but the
 * reconciler attaches a `yogaNode` (and a `parentNode` chain) at runtime. Summing
 * `getComputedTop` / `getComputedLeft` up the chain yields the node's 0-based
 * absolute terminal coordinate — the only way to translate an absolute mouse-click
 * report into a position within a specific rendered element.
 *
 * Extracted from `Input.tsx` (click-to-cursor) so the same helper backs every
 * clickable surface (the `/agents` panel rows, the footer subagent chip) and is
 * unit-testable with a Yoga stub. Returns null when the node isn't laid out yet
 * (first render, or the jsdom test mock with no Yoga).
 */
import type { DOMElement } from "ink"

/** Structural view of an Ink DOM node's Yoga layout (not in the public type). */
export type InkLayoutNode = {
  yogaNode?: { getComputedTop?: () => number; getComputedLeft?: () => number }
  parentNode?: InkLayoutNode
}

/** Absolute terminal top-left (0-based) of an Ink node, or null if unlaid-out. */
export function absoluteTopLeft(node: DOMElement | null): { top: number; left: number } | null {
  let cur: InkLayoutNode | undefined = (node as unknown as InkLayoutNode | null) ?? undefined
  if (!cur?.yogaNode) return null
  let top = 0
  let left = 0
  while (cur?.yogaNode) {
    top += cur.yogaNode.getComputedTop?.() ?? 0
    left += cur.yogaNode.getComputedLeft?.() ?? 0
    cur = cur.parentNode
  }
  return { top, left }
}
