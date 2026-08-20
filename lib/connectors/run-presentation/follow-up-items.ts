/**
 * The run-control verbs a follow-up registration offers.
 *
 * Lifted out of the Feishu driver so the generic fallback path can register
 * the same items. Run control used to exist on exactly one platform of twelve,
 * because only that driver ever wrote a `followUpControl` registration — the
 * matcher below it was already platform-neutral.
 *
 * A platform without native follow-up bubbles still gets these: the verbs are
 * printed in the card body, and typing one back matches the same registration.
 * Rendering is a capability; control is not.
 */

import type { RunControlAction, RunProjectionSnapshot } from "@/types/execution/run"
import { safeStableActivityId } from "@/lib/execution/run-activity"
import type { FollowUpControlItem } from "@/lib/connectors/follow-up-control"

export const RUN_ACTION_LABEL_EN: Record<RunControlAction, string> = {
  stop: "Stop",
  pause: "Pause",
  resume: "Resume",
  approve: "Approve",
  deny: "Deny",
  retry: "Retry",
  open_details: "View details",
}

export const RUN_ACTION_LABEL_ZH: Record<RunControlAction, string> = {
  stop: "停止",
  pause: "暂停",
  resume: "继续",
  approve: "批准",
  deny: "拒绝",
  retry: "重试",
  open_details: "查看详情",
}

/** How long a registration stays matchable. */
export const FOLLOW_UP_TTL_MS = 600_000

/**
 * Two state-changing verbs plus status, capped at three.
 *
 * `open_details` is excluded: it is a link, not a control, and spending one of
 * three slots on it would push out a verb that actually does something.
 */
export function buildFollowUpItems(snapshot: RunProjectionSnapshot): FollowUpControlItem[] {
  const actionable = snapshot.allowedActions
    .filter((action) => action !== "open_details")
    .slice(0, 2)
    .map((action) => ({
      action,
      content: RUN_ACTION_LABEL_EN[action],
      localizedContent: RUN_ACTION_LABEL_ZH[action],
      ...(snapshot.pendingInterrupt
        ? { interruptId: safeStableActivityId(snapshot.pendingInterrupt.id) }
        : {}),
    }))
  return [
    ...actionable,
    { action: "status" as const, content: "View status", localizedContent: "查看状态" },
  ].slice(0, 3)
}

/** The verbs, as a line appended to a card body on platforms with no bubbles. */
export function followUpHintLine(items: FollowUpControlItem[], zh: boolean): string | undefined {
  if (items.length === 0) return undefined
  const labels = items.map((item) => (zh ? item.localizedContent : item.content)).filter(Boolean)
  if (labels.length === 0) return undefined
  return zh ? `回复以操作：${labels.join(" / ")}` : `Reply to act: ${labels.join(" / ")}`
}
