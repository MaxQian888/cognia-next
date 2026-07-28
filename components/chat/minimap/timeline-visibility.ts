/**
 * Mount gate for the conversation timeline minimap.
 *
 * Extracted as a pure predicate (same shape as
 * `components/inbox/adapter-health-decision.ts`) so the branch count lives in a
 * cheap node-env test instead of `message-list.tsx`'s render coverage.
 *
 * The gate is **pane-relative, not viewport-relative**. It used to read
 * `useMediaQuery("(min-width: 1024px)")` while the timeline itself is
 * positioned against the message pane — so every host that renders a
 * `MessageList` narrower than the window got a 256px panel dropped on top of
 * its reading column: the Inbox detail pane (56% of the window by default, 40%
 * at its floor) and the main chat page's split view, which mounts two panes
 * side by side.
 */

/**
 * Narrowest pane that can host the expanded timeline, in CSS px.
 *
 * The expanded panel is a fixed `w-64` (256px) and sits in flow, so it costs
 * the reading column exactly that. At this floor the column keeps 640px — the
 * repo's `md` content width, still a comfortable measure.
 *
 * Mirrored in CSS by `@4xl/message-list` on the timeline root. Tailwind v4's
 * `@4xl` is 56rem = 896px exactly, so the two cannot drift apart.
 */
export const TIMELINE_MIN_PANE_PX = 896

export interface TimelineVisibilityInput {
  /** Measured pane width. `0` means "not yet measured" and never mounts. */
  paneWidth: number
  /** Touch viewports get the action sheet instead; the minimap is pointer-only. */
  isMobile: boolean
  /** `settings.conversationTimeline.enabled`; `undefined` means opted in. */
  enabled: boolean | undefined
  messageCount: number
  /** Conversations shorter than this have nothing worth navigating. */
  threshold: number
}

export function shouldMountTimeline({
  paneWidth,
  isMobile,
  enabled,
  messageCount,
  threshold,
}: TimelineVisibilityInput): boolean {
  if (isMobile) return false
  if (enabled === false) return false
  if (messageCount <= threshold) return false
  return paneWidth >= TIMELINE_MIN_PANE_PX
}
