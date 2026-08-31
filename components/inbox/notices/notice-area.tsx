"use client"

/**
 * The Inbox detail pane's single notice surface.
 *
 * Before this, five independent strips mounted themselves in two different
 * places — two adapter-level ones from `inbox-shell`, three conversation-level
 * ones from the `/inbox/c` route — each a full-bleed coloured band with its own
 * height and palette. A conversation with a degraded adapter, a saturated
 * outbound queue, a stalled inbound job, a pending draft and some activity
 * opened behind six horizontal seams before the first message.
 *
 * They now aggregate here: one seam, one palette, and a collapsed summary once
 * there is more than one. Mounted by `inbox-shell` for every Inbox route;
 * conversation-scoped sources stay empty until a `conversationKey` arrives
 * (every underlying hook already short-circuits on a falsy key, so they are
 * called unconditionally as the rules of hooks require).
 *
 * This component owns the queries and hands each notice its data as props.
 * That is what lets it know the notice *count* during its own render — the
 * sources cannot report presence upward without a render-phase write.
 *
 * Mobile suppression is **per source**, not blanket. Adapter-level notices are
 * hidden on a phone (the per-conversation badges carry the same signal in the
 * single-pane stack), but draft / recovery / activity are conversation-scoped
 * and must stay reachable — the draft notice is the only entry point to the
 * draft editor on a phone.
 *
 * That suppression is a viewport fact, so it has to reach the *counting*, not
 * just the painting. `hidden md:block` alone left a phone with a bordered empty
 * band whenever every live notice was adapter-level, and made the collapsed
 * summary claim notices the reader could not see. The rows keep the CSS class
 * anyway: `useIsMobile` reports desktop for the pre-hydration frame, and the
 * class is what stops adapter notices flashing in before the store settles.
 */

import { useState, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import { motion, useReducedMotion } from "motion/react"
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Surface } from "@/components/surface/surface"
import { cn } from "@/lib/utils"
import { useIsMobile } from "@/hooks/ui/use-mobile"
import { useDegradedAdapters } from "@/hooks/connectors/use-degraded-adapters"
import { useOutboundSaturation } from "@/hooks/connectors/use-outbound-saturation"
import { useInboundRecoveryJobs } from "@/hooks/connectors/use-inbound-recovery-jobs"
import { usePendingDraftsForConversation } from "@/hooks/connectors/use-pending-drafts"
import { useConversationActivity } from "@/hooks/connectors/use-conversation-activity"
import { useConversationAssignmentEvents } from "@/hooks/connectors/use-conversation-assignment-events"
import { ConnectionLossNotice } from "../connection-loss-banner"
import { OutboundSaturationNotice } from "../outbound-saturation-banner"
import { InboundRecoveryNotice } from "../inbound-recovery-panel"
import { DraftNotice } from "../draft-banner"
import { ConversationActivityNotice } from "../conversation-activity-log"

export interface InboxNoticeAreaProps {
  /** Conversation-scoped sources stay empty when this is absent. */
  conversationKey?: string
  className?: string
}

export function InboxNoticeArea({ conversationKey, className }: InboxNoticeAreaProps) {
  const t = useTranslations("inbox.notices")
  const reduce = useReducedMotion()
  const isMobile = useIsMobile()
  const [expanded, setExpanded] = useState(false)

  const degraded = useDegradedAdapters()
  const saturation = useOutboundSaturation()
  const recoveryJobs = useInboundRecoveryJobs(conversationKey)
  const drafts = usePendingDraftsForConversation(conversationKey)
  const auditEntries = useConversationActivity(conversationKey)
  const assignmentEvents = useConversationAssignmentEvents(conversationKey)

  const activityCount = auditEntries.length + assignmentEvents.length
  const firstDraft = drafts[0]

  const notices: Array<{ id: string; mobileHidden: boolean; node: ReactNode }> = []
  if (degraded.adapters.length > 0) {
    notices.push({
      id: "connection-loss",
      mobileHidden: true,
      node: <ConnectionLossNotice adapters={degraded.adapters} onDismiss={degraded.dismiss} />,
    })
  }
  if (saturation.adapters.length > 0) {
    notices.push({
      id: "outbound-saturation",
      mobileHidden: true,
      node: (
        <OutboundSaturationNotice adapters={saturation.adapters} onDismiss={saturation.dismiss} />
      ),
    })
  }
  // Conversation-scoped sources are gated explicitly rather than left to each
  // hook's own empty-key guard — that made the narrowing implicit and forced a
  // non-null assertion on `conversationKey` at the one place it is passed down.
  if (conversationKey) {
    if (recoveryJobs.length > 0) {
      notices.push({
        id: "inbound-recovery",
        mobileHidden: false,
        node: <InboundRecoveryNotice jobs={recoveryJobs} />,
      })
    }
    if (firstDraft) {
      notices.push({
        id: "draft",
        mobileHidden: false,
        node: <DraftNotice draft={firstDraft} conversationKey={conversationKey} />,
      })
    }
    if (activityCount > 0) {
      notices.push({
        id: "activity",
        mobileHidden: false,
        node: (
          <ConversationActivityNotice
            auditEntries={auditEntries}
            assignmentEvents={assignmentEvents}
          />
        ),
      })
    }
  }

  // Everything downstream — the empty check, the count, the disclosure — reads
  // the set this viewport can actually show.
  const visible = isMobile ? notices.filter((notice) => !notice.mobileHidden) : notices
  if (visible.length === 0) return null

  // One notice needs no disclosure — "1 notice ▸" over a single row is pure
  // chrome. Past that, start collapsed so the conversation still opens near
  // the top of the pane.
  const collapsible = visible.length > 1
  const open = !collapsible || expanded

  return (
    <Surface
      layer="raised"
      radius="none"
      // `bg-muted/30` before. A hardcoded background is invisible to the
      // wallpaper layer, so this band sat opaque over one while the panes
      // around it went translucent (ADR-0148).
      className={cn("shrink-0 border-b", className)}
      role="region"
      aria-label={t("region")}
      data-testid="inbox-notice-area"
      data-notice-count={visible.length}
    >
      {collapsible && (
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start gap-1.5 rounded-none px-3 py-1 text-xs text-muted-foreground"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-label={expanded ? t("collapse") : t("expand")}
          data-testid="inbox-notice-toggle"
        >
          {expanded ? (
            <ChevronDownIcon className="size-3" aria-hidden />
          ) : (
            <ChevronRightIcon className="size-3" aria-hidden />
          )}
          <span>{t("summary", { count: visible.length })}</span>
        </Button>
      )}
      {/* Always mounted, height-animated. Unmounting the rows would tear down
          the Sheet the draft notice owns mid-review. */}
      <motion.div
        initial={false}
        animate={open ? { height: "auto", opacity: 1 } : { height: 0, opacity: 0 }}
        transition={reduce ? { duration: 0 } : undefined}
        className="overflow-hidden"
        data-testid="inbox-notice-list"
      >
        {visible.map((notice) => (
          <div key={notice.id} className={cn(notice.mobileHidden && "hidden md:block")}>
            {notice.node}
          </div>
        ))}
      </motion.div>
    </Surface>
  )
}
