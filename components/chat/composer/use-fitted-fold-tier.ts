"use client"

import { useState, type RefObject } from "react"

import { useIsomorphicLayoutEffect } from "@/hooks/use-isomorphic-layout-effect"
import { resolveToolbarFoldTier, type ToolbarFoldTier } from "@/lib/chat/composer-skin"

/**
 * The fold ladder's second opinion: the width thresholds propose a tier, the
 * rendered row confirms it.
 *
 * `TOOLBAR_FOLD_PX` is a guess about how wide the roster is, made before any
 * of it renders — and the roster is not a fixed size. The web shell adds a
 * "Local runtime" status pill, a missing key adds the credential badge, a
 * plugin contributes a dial, the locale doubles a label. At 792px the full
 * labelled roster measured ~830px, so tier 0 shipped exactly the row the
 * ladder exists to prevent: "Standard" shaved to "S…", "Cognia Agent" to
 * "Cog…", the thinking level to "A…".
 *
 * So after every commit this hook asks the row whether any label is being
 * squeezed; if one is, it steps one rung further down and asks again. The
 * steps run in a layout effect, so the intermediate rungs never paint — the
 * user only ever sees the tier that fits.
 *
 * The extra rungs are keyed by width AND a content signature. A wider pane or
 * a different roster (another session, model or runtime) starts again from the
 * threshold tier, so a row never stays folded because of what it used to hold.
 * Content that shrinks without changing the signature (a key being added, so
 * the credential badge leaves) keeps its rungs until the next resize — the row
 * errs towards folding, which is the invariant: a control may move into "⋯",
 * but a label is never shaved.
 */
export function useFittedFoldTier(
  rootRef: RefObject<HTMLElement | null>,
  width: number,
  signature: string
): ToolbarFoldTier {
  const base = resolveToolbarFoldTier(width)
  const [bump, setBump] = useState<{ width: number; signature: string; extra: number }>({
    width: 0,
    signature: "",
    extra: 0,
  })
  const extra = bump.width === width && bump.signature === signature ? bump.extra : 0
  const tier = Math.min(4, base + extra) as ToolbarFoldTier

  // No dependency list on purpose: a label can be squeezed by any re-render
  // (a chip's value changing, a plugin slot mounting), and the check is one
  // query over a single toolbar row.
  useIsomorphicLayoutEffect(() => {
    const root = rootRef.current
    // Unmeasured (`0`) renders the widest form without judging it, like the
    // threshold resolver; the last rung has nothing left to fold.
    if (!root || width <= 0 || tier >= 4) return
    if (isToolbarSqueezed(root)) setBump({ width, signature, extra: extra + 1 })
  })

  return tier
}

/**
 * Is something in this row being ellipsized because the ROW is too narrow?
 *
 * Two symptoms count: the row's own content overflowing its box, and a
 * `truncate` label clipped while none of its boxes sits at a deliberate
 * `max-width` cap. The second clause is what keeps a long model id — capped
 * at `11rem` by design — from walking the ladder to the bottom: that label is
 * clipped at every tier, and folding more of the row would not un-clip it.
 */
export function isToolbarSqueezed(root: HTMLElement): boolean {
  if (root.scrollWidth > root.clientWidth + 1) return true
  for (const label of root.querySelectorAll<HTMLElement>(".truncate")) {
    if (label.scrollWidth <= label.clientWidth + 1) continue
    if (!isCappedWithin(label, root)) return true
  }
  return false
}

function isCappedWithin(label: HTMLElement, root: HTMLElement): boolean {
  for (let node: HTMLElement | null = label; node && node !== root; node = node.parentElement) {
    const max = getComputedStyle(node).maxWidth
    // Only an absolute cap is a design decision about this label. `none` has
    // no cap, and a percentage cap is a share of whatever the row gave it —
    // which is exactly the squeeze being detected.
    if (!max.endsWith("px")) continue
    const limit = Number.parseFloat(max)
    if (Number.isFinite(limit) && node.getBoundingClientRect().width >= limit - 1) return true
  }
  return false
}
