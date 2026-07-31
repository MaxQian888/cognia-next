import * as React from "react"
import { Collapsible as CollapsiblePrimitive } from "radix-ui"

/**
 * Show/hide region with the trigger ⇄ content ARIA wiring already done
 * (`aria-controls`, `aria-expanded`, and an id the caller never has to mint).
 *
 * Deliberately unstyled and unanimated, exactly as in the host: a collapsible
 * is a behavior, not a look, and every call site wants a different one. Note
 * that Radix drops the content from the DOM while closed unless `forceMount` is
 * set — assert on visibility, not on class names, and remember that a closed
 * region's focusable descendants genuinely do not exist.
 *
 * Animating it is the caller's choice, and the constraint worth knowing first
 * is that Radix defers an exit only for a real CSS `@keyframes` animation — a
 * transition is not detected, and the content is gone before it can play. So
 * either give the content keyframes (what `./accordion` does), or take presence
 * yourself with `forceMount` and wrap the body in `Collapse` from `./motion`.
 */
function Collapsible({ ...props }: React.ComponentProps<typeof CollapsiblePrimitive.Root>) {
  return <CollapsiblePrimitive.Root data-slot="collapsible" {...props} />
}

function CollapsibleTrigger({
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleTrigger>) {
  return <CollapsiblePrimitive.CollapsibleTrigger data-slot="collapsible-trigger" {...props} />
}

function CollapsibleContent({
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleContent>) {
  return <CollapsiblePrimitive.CollapsibleContent data-slot="collapsible-content" {...props} />
}

export { Collapsible, CollapsibleTrigger, CollapsibleContent }
