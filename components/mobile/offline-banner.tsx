"use client"

/**
 * Offline / queue banner (Wave 3.5).
 *
 * Shows above all routed content when:
 *   - The network is offline, OR
 *   - The mobile outbound queue has pending rows (regardless of network).
 *
 * Gated on the COMPACT LAYOUT, not on the native platform. It used to ask
 * `usePlatform() === "mobile"`, which is the capability question, and the
 * compact shell also draws in a narrow browser tab: a 375px window got the
 * phone frame with no offline or queue indicator anywhere in it. The queue is
 * not native-only either — `lib/queue/outbound-queue.ts` says in its own
 * header that the runner is platform-agnostic and serves attached Web, Mobile
 * and Desktop callers — so a browser could hold pending rows and show nothing
 * about them.
 *
 * The queue count is read through a Dexie live query, so newly enqueued and
 * drained rows update the banner reactively rather than on a polling timer.
 *
 * On a paired device the network being up says nothing about the Host: the
 * phone's Wi-Fi is fine while the desktop sleeps or the cloud Host redeploys.
 * The runtime snapshot's `connectionState` is the Host-side answer, so the
 * banner reads it too — "reconnecting" while the transport is re-dialling,
 * and the offline copy once it has given up — but only for a companion
 * target: a standalone tab has no Host to be disconnected from, and the
 * empty snapshot reports `offline` by construction.
 */

import { useEffect, useSyncExternalStore } from "react"
import { useTranslations } from "next-intl"
import { CloudOffIcon, LoaderIcon, TriangleAlertIcon } from "lucide-react"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"

import { useClientLiveQuery } from "@/hooks/data"
import { useNetworkStatus } from "@/hooks/use-network-status"
import { useRuntimeSnapshot } from "@/hooks/use-runtime-snapshot"
import { useCompactLayout } from "@/hooks/ui/use-compact-layout"
import { getQueueSummary, inFlight, needsAttention } from "@/lib/queue/outbound-queue"
import {
  outboundConsentCode,
  PENDING_NO_CODE,
  registerOutboundApprovalReporter,
  subscribeOutboundApproval,
} from "@/lib/queue/outbound-approval"
import { MOBILE_DURATION, MOBILE_EASE } from "@/lib/ui/motion"
import { cn } from "@/lib/utils"

export interface OfflineBannerProps {
  className?: string
}

export function OfflineBanner({ className }: OfflineBannerProps) {
  const t = useTranslations("mobile.offline")
  const compact = useCompactLayout()
  const { status, loading } = useNetworkStatus()
  const runtime = useRuntimeSnapshot()
  // `getQueueSummary` reads the `mobileOutboundQueue` table, so wrapping it in
  // a live query makes the banner react to enqueue/drain writes instead of
  // re-counting on a fixed 15s interval. The banner only mounts inside the
  // mobile shell, so this query never runs on web/desktop.
  // A queue frozen on an interactive approval is not offline, not retrying and
  // not stuck: the Host is asking a human, and until someone answers, the rows
  // simply do not move. Reported here because the alternative is a count that
  // sits at "1 queued" forever with nothing on screen saying why, which is the
  // silence this whole gate exists to end.
  const consentCode = useSyncExternalStore(
    subscribeOutboundApproval,
    outboundConsentCode,
    () => null
  )
  // Claim the wait for as long as this banner is mounted, so the runner's
  // fallback toast stays out of the way here and fires on every shell that
  // does NOT mount this banner, which is all of them but the mobile ones.
  useEffect(() => registerOutboundApprovalReporter(), [])
  const queue = useClientLiveQuery<{ inFlight: number; stuck: number }>(
    async () => {
      const summary = await getQueueSummary()
      return { inFlight: inFlight(summary), stuck: needsAttention(summary) }
    },
    [],
    { inFlight: 0, stuck: 0 }
  )

  if (!compact) return null
  if (loading) return null

  const hostState = runtime.target?.kind === "companion" ? runtime.connectionState : "online"
  const hostOffline = status.connected && hostState === "offline"
  const offline = !status.connected || hostOffline
  const reconnecting = !offline && hostState === "connecting"
  const pendingCount = queue?.inFlight ?? 0
  // Rows the Host refused, ran out of retries on, or that lost a race. Nothing
  // will move them on its own, and they used to be reported by no surface at
  // all — a refused action looked exactly like one that had gone through.
  const stuckCount = queue?.stuck ?? 0
  const visible =
    offline || reconnecting || pendingCount > 0 || stuckCount > 0 || consentCode !== null

  return (
    <AnimatePresence initial={false}>
      {visible ? (
        <BannerBody
          offline={offline}
          hostOffline={hostOffline}
          reconnecting={reconnecting}
          pending={pendingCount}
          stuck={stuckCount}
          messageOffline={hostOffline ? t("bannerHostOffline") : t("bannerOffline")}
          messageReconnecting={t("bannerReconnecting")}
          messageQueue={
            consentCode
              ? consentCode === PENDING_NO_CODE
                ? t("queueAwaitingApprovalNoCode")
                : t("queueAwaitingApproval", { code: consentCode })
              : stuckCount > 0
                ? t("queueNeedsAttention", { count: stuckCount })
                : t("queuePending", { count: pendingCount })
          }
          className={className}
        />
      ) : null}
    </AnimatePresence>
  )
}

interface BannerBodyProps {
  offline: boolean
  /** The device network is up but the paired Host is not answering. */
  hostOffline: boolean
  reconnecting: boolean
  pending: number
  stuck: number
  messageOffline: string
  messageReconnecting: string
  messageQueue: string
  className?: string
}

function BannerBody({
  offline,
  hostOffline,
  reconnecting,
  pending,
  stuck,
  messageOffline,
  messageReconnecting,
  messageQueue,
  className,
}: BannerBodyProps) {
  const reduce = useReducedMotion()
  return (
    <motion.div
      role="status"
      aria-live="polite"
      data-testid="offline-banner"
      data-offline={offline ? "true" : "false"}
      data-host-offline={hostOffline ? "true" : "false"}
      data-reconnecting={reconnecting ? "true" : "false"}
      data-stuck={stuck > 0 ? "true" : "false"}
      initial={reduce ? false : { opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={reduce ? { opacity: 0 } : { opacity: 0, y: -8 }}
      transition={{
        duration: MOBILE_DURATION.fast,
        ease: MOBILE_EASE,
      }}
      className={cn(
        "sticky top-0 z-30 flex items-center gap-2 border-b border-border px-3 py-2 text-xs",
        offline || stuck > 0
          ? "bg-destructive/10 text-destructive"
          : "bg-amber-500/10 text-amber-700 dark:text-amber-300",
        className
      )}
    >
      {offline ? (
        <CloudOffIcon className="size-3.5" aria-hidden="true" />
      ) : reconnecting ? (
        <LoaderIcon className="size-3.5 animate-spin" aria-hidden="true" />
      ) : stuck > 0 ? (
        // Not a spinner: nothing is retrying these, and an animation that says
        // "working on it" is the wrong thing to show for work that has stopped.
        <TriangleAlertIcon className="size-3.5" aria-hidden="true" />
      ) : (
        <LoaderIcon className="size-3.5 animate-spin" aria-hidden="true" />
      )}
      <span className="flex-1">
        {offline ? messageOffline : reconnecting ? messageReconnecting : messageQueue}
      </span>
      {/* `pending` is included in the queue message via t("queuePending"); kept
       *  as a separate prop so this component is trivial to render-test. */}
      <span className="sr-only">{pending}</span>
    </motion.div>
  )
}
