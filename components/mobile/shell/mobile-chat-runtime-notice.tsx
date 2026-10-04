"use client"

/**
 * What the phone shell shows when chat cannot send (`useChatRuntimeGate`), in
 * the `desktop.chatRuntime` vocabulary the desktop workspace uses, in two
 * densities:
 *
 * - `MobileChatRuntimeNotice`, the centred card for a conversation with no
 *   history, where it IS the screen: title, explanation, a full-width 44px
 *   action.
 * - `MobileChatRuntimeStrip`, one line docked on the composer's top edge for a
 *   conversation with history, where the transcript is the content and the
 *   card used to push it down under two more bands saying the same thing.
 *
 * Both take the connection-notice claim, so the shell's generic offline banner
 * and the route's read-only Alert stand down while either is up. The strip
 * also carries the outbound queue and takes that claim too; the card does not,
 * so on an empty conversation the queue stays on the banner.
 */

import { useEffect, useState } from "react"
import { Surface } from "@/components/surface/surface"
import { useTranslations } from "next-intl"
import { CloudOffIcon, LoaderIcon, TriangleAlertIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  runtimeAvailabilityMessageKey,
  type ChatRuntimeGate,
} from "@/hooks/chat/use-chat-runtime-gate"
import { OutboundQueueSheet } from "@/components/mobile/outbound-queue-sheet"
import { useOutboundQueueStatus } from "@/hooks/use-outbound-queue-status"
import { claimConnectionNotice, claimQueueNotice } from "@/lib/runtime/connection-notice-claim"

export interface MobileChatRuntimeNoticeProps {
  gate: ChatRuntimeGate
  /** Navigate to a route (pairing / recovery). */
  onNavigate: (href: string) => void
  /** Open a local settings section. */
  onOpenSettings: (section: string) => void
}

export function MobileChatRuntimeNotice({
  gate,
  onNavigate,
  onOpenSettings,
}: MobileChatRuntimeNoticeProps) {
  const t = useTranslations("desktop.chatRuntime")
  const { availability, recovery, connecting } = gate
  const offline = availability.state === "offline"
  useEffect(() => claimConnectionNotice(), [])
  return (
    <Surface
      className="flex flex-col gap-3 rounded-xl border border-border/70 bg-muted/20 p-4 text-sm"
      role="status"
      data-testid="chat-runtime-notice"
    >
      <div className="min-w-0">
        <p className="font-medium">{t(offline ? "connectionTitle" : "title")}</p>
        <p className="text-muted-foreground">
          {t(
            connecting && offline
              ? "connecting"
              : `states.${runtimeAvailabilityMessageKey(availability.state)}`
          )}
        </p>
      </div>
      {recovery.kind !== "none" ? (
        <Button
          type="button"
          variant="outline"
          className="h-11 w-full"
          data-testid="chat-runtime-notice-action"
          onClick={() => runRecovery(gate, onNavigate, onOpenSettings)}
        >
          {t(recoveryLabelKey(gate))}
        </Button>
      ) : null}
    </Surface>
  )
}

/**
 * The same report as {@link MobileChatRuntimeNotice} at strip density: state,
 * "cached chats only", and the recovery action as a trailing text button. The
 * long explanation the card spells out is kept for screen readers only.
 */
export function MobileChatRuntimeStrip({
  gate,
  onNavigate,
  onOpenSettings,
}: MobileChatRuntimeNoticeProps) {
  const t = useTranslations("desktop.chatRuntime")
  const tOffline = useTranslations("mobile.offline")
  const { availability, recovery, connecting } = gate
  const offline = availability.state === "offline"
  const reconnecting = connecting && offline
  // The outbound queue rides this line too ("Reconnecting · 2 queued"): while
  // the Host is away the queue IS the rest of the story, and the shell banner
  // repeating it at the top of the screen was a second band for one state.
  const queue = useOutboundQueueStatus()
  const [queueOpen, setQueueOpen] = useState(false)
  useEffect(() => claimConnectionNotice(), [])
  useEffect(() => claimQueueNotice(), [])
  const Icon = reconnecting ? LoaderIcon : offline ? CloudOffIcon : TriangleAlertIcon
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="chat-runtime-strip"
      data-state={reconnecting ? "reconnecting" : availability.state}
      // The run strip's own tab shape (`run-panel.tsx`): open at the bottom so
      // it meets the composer card, corners from the slot's `--run-strip-radius`.
      className="flex min-h-8 items-center gap-1 rounded-t-[var(--run-strip-radius,0.625rem)] border border-b-0 border-border/60 bg-muted/45 py-0.5 ps-2.5 pe-1 text-xs backdrop-blur-sm"
    >
      <Icon
        aria-hidden
        className={
          reconnecting
            ? "size-3.5 shrink-0 animate-spin text-amber-600 dark:text-amber-400"
            : "size-3.5 shrink-0 text-destructive"
        }
      />
      <span className="ms-0.5 min-w-0 flex-1 truncate">
        <span className="font-medium">
          {reconnecting
            ? t("strip.connecting")
            : t(`strip.states.${runtimeAvailabilityMessageKey(availability.state)}`)}
        </span>
        {/* The queue, when there is one, says more than "cached only" — that
            sends are waiting, or that some stopped and need a decision. */}
        <span
          data-testid="chat-runtime-strip-detail"
          className={queue.visible && queue.stuck > 0 ? "text-destructive" : "text-muted-foreground"}
        >
          {" · "}
          {queue.visible ? queue.message : t("strip.cacheOnly")}
        </span>
        <span className="sr-only">
          {" "}
          {t(
            reconnecting
              ? "connecting"
              : `states.${runtimeAvailabilityMessageKey(availability.state)}`
          )}
        </span>
      </span>
      {queue.visible && queue.hasRows ? (
        <button
          type="button"
          data-testid="chat-runtime-strip-queue"
          onClick={() => setQueueOpen(true)}
          className={STRIP_BUTTON}
        >
          {tOffline("review")}
        </button>
      ) : null}
      {recovery.kind !== "none" ? (
        <button
          type="button"
          data-testid="chat-runtime-strip-action"
          onClick={() => runRecovery(gate, onNavigate, onOpenSettings)}
          className={STRIP_BUTTON}
        >
          {t(`strip.${recoveryLabelKey(gate)}`)}
        </button>
      ) : null}
      <OutboundQueueSheet open={queueOpen} onOpenChange={setQueueOpen} />
    </div>
  )
}

/**
 * A text button at strip height. `touch-hit` grows its hit area to the 44px
 * floor vertically so the line itself stays 32px; the labels are one word
 * ("Settings", "Review") so the state text keeps the width.
 */
const STRIP_BUTTON =
  "touch-hit shrink-0 rounded-md px-1.5 py-1 font-medium text-primary hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"

function recoveryLabelKey(gate: ChatRuntimeGate): string {
  return gate.availability.state === "requires-pairing"
    ? "actions.pair"
    : "actions.connectionSettings"
}

function runRecovery(
  gate: ChatRuntimeGate,
  onNavigate: (href: string) => void,
  onOpenSettings: (section: string) => void
): void {
  const { recovery } = gate
  if (recovery.kind === "route") onNavigate(recovery.href)
  else if (recovery.kind !== "none") onOpenSettings(recovery.section)
}
