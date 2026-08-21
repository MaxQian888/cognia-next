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
  steer: "Steer",
}

export const RUN_ACTION_LABEL_ZH: Record<RunControlAction, string> = {
  stop: "停止",
  pause: "暂停",
  resume: "继续",
  approve: "批准",
  deny: "拒绝",
  retry: "重试",
  open_details: "查看详情",
  steer: "调整",
}

/**
 * How a typed reply is matched against a registration item.
 *
 * `exact` is the original rule and stays the default: a bare "Stop" is a
 * control only because it matches a label exactly, which is what keeps the
 * word from firing on an ordinary sentence.
 *
 * `steer` cannot work that way — it carries a payload. It matches a PREFIX and
 * treats the remainder as the correction, which also means it must not consume
 * the registration: buttons are one-shot, but a person redirecting work says
 * several things over the life of one run.
 */
export const STEER_PREFIX_EN = "steer:"
export const STEER_PREFIX_ZH = "调整："
/** Half-width colon too — IM keyboards produce both, and users type both. */
export const STEER_PREFIX_ZH_ASCII = "调整:"

export interface FollowUpMatch {
  item: FollowUpControlItem
  /** Present only for a prefix match; already trimmed, never empty. */
  steerMessage?: string
  /** Prefix matches leave the registration in place for the next correction. */
  consumes: boolean
}

/**
 * Resolve a typed reply against a registration.
 *
 * Exact matches are tried first so a message that happens to start with a
 * prefix but IS a bare verb cannot be misread as a steer with an empty body.
 */
export function matchFollowUpItem(
  items: readonly FollowUpControlItem[],
  text: string
): FollowUpMatch | undefined {
  const trimmed = text.trim()
  const exact = items.find(
    (item) =>
      item.match !== "prefix" && (item.content === trimmed || item.localizedContent === trimmed)
  )
  if (exact) return { item: exact, consumes: true }

  for (const item of items) {
    if (item.match !== "prefix") continue
    for (const prefix of [item.content, item.localizedContent, STEER_PREFIX_ZH_ASCII]) {
      if (!prefix || !trimmed.toLowerCase().startsWith(prefix.toLowerCase())) continue
      const body = trimmed.slice(prefix.length).trim()
      // A bare prefix carries no correction. Refusing it here is what stops an
      // empty steer from reaching the control gate as an `invalid_command`.
      if (!body) continue
      return { item, steerMessage: body, consumes: false }
    }
  }
  return undefined
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
    .filter((action) => action !== "open_details" && action !== "steer")
    .slice(0, 2)
    .map((action) => ({
      action,
      content: RUN_ACTION_LABEL_EN[action],
      localizedContent: RUN_ACTION_LABEL_ZH[action],
      ...(snapshot.pendingInterrupt
        ? { interruptId: safeStableActivityId(snapshot.pendingInterrupt.id) }
        : {}),
    }))
  const capped: FollowUpControlItem[] = [
    ...actionable,
    { action: "status" as const, content: "View status", localizedContent: "查看状态" },
  ].slice(0, 3)
  // The steer item is appended OUTSIDE the cap. It costs no button slot (it is
  // matched by prefix, not offered as a tap target), and dropping it to stay
  // under three would remove the only verb that can redirect work in flight.
  if (snapshot.allowedActions.includes("steer")) {
    capped.push({
      action: "steer",
      content: STEER_PREFIX_EN,
      localizedContent: STEER_PREFIX_ZH,
      match: "prefix",
    })
  }
  return capped
}

/** The verbs, as a line appended to a card body on platforms with no bubbles. */
export function followUpHintLine(items: FollowUpControlItem[], zh: boolean): string | undefined {
  if (items.length === 0) return undefined
  const labels = items
    .map((item) => {
      const label = zh ? item.localizedContent : item.content
      // A prefix verb is useless printed as a bare word: the reader has to know
      // something follows it. Show the shape they must type.
      return item.match === "prefix" ? `${label}${zh ? "…" : " …"}` : label
    })
    .filter(Boolean)
  if (labels.length === 0) return undefined
  return zh ? `回复以操作：${labels.join(" / ")}` : `Reply to act: ${labels.join(" / ")}`
}
