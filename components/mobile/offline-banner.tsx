"use client"

/**
 * Offline / queue banner (Wave 3.5).
 *
 * Shows above all routed content when:
 *   - The network is offline, OR
 *   - The mobile outbound queue has pending rows (regardless of network).
 *
 * On non-mobile platforms it stays hidden (`usePlatform()` gate). The queue
 * count is read through a Dexie live query, so newly enqueued/drained rows
 * update the banner reactively — no polling timer.
 */

import { useTranslations } from "next-intl"
import { CloudOffIcon, LoaderIcon } from "lucide-react"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"

import { useClientLiveQuery } from "@/hooks/data"
import { useNetworkStatus } from "@/hooks/use-network-status"
import { usePlatform } from "@/hooks/use-platform"
import { getQueueSummary } from "@/lib/queue/outbound-queue"
import { MOBILE_DURATION, MOBILE_EASE } from "@/lib/ui/motion"
import { cn } from "@/lib/utils"

export interface OfflineBannerProps {
  className?: string
}

export function OfflineBanner({ className }: OfflineBannerProps) {
  const t = useTranslations("mobile.offline")
  const platform = usePlatform()
  const { status, loading } = useNetworkStatus()
  // `getQueueSummary` reads the `mobileOutboundQueue` table, so wrapping it in
  // a live query makes the banner react to enqueue/drain writes instead of
  // re-counting on a fixed 15s interval. The banner only mounts inside the
  // mobile shell, so this query never runs on web/desktop.
  const pending = useClientLiveQuery<number>(
    async () => {
      const summary = await getQueueSummary()
      return summary.pending + summary.failed
    },
    [],
    0
  )

  if (platform !== "mobile") return null
  if (loading) return null

  const offline = !status.connected
  const pendingCount = pending ?? 0
  const showQueue = pendingCount > 0
  const visible = offline || showQueue

  return (
    <AnimatePresence initial={false}>
      {visible ? (
        <BannerBody
          offline={offline}
          pending={pendingCount}
          messageOffline={t("bannerOffline")}
          messageQueue={t("queuePending", { count: pendingCount })}
          className={className}
        />
      ) : null}
    </AnimatePresence>
  )
}

interface BannerBodyProps {
  offline: boolean
  pending: number
  messageOffline: string
  messageQueue: string
  className?: string
}

function BannerBody({
  offline,
  pending,
  messageOffline,
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
      initial={reduce ? false : { opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={reduce ? { opacity: 0 } : { opacity: 0, y: -8 }}
      transition={{
        duration: MOBILE_DURATION.fast,
        ease: MOBILE_EASE,
      }}
      className={cn(
        "sticky top-0 z-30 flex items-center gap-2 border-b border-border px-3 py-2 text-xs",
        offline
          ? "bg-destructive/10 text-destructive"
          : "bg-amber-500/10 text-amber-700 dark:text-amber-300",
        className
      )}
    >
      {offline ? (
        <CloudOffIcon className="size-3.5" aria-hidden="true" />
      ) : (
        <LoaderIcon className="size-3.5 animate-spin" aria-hidden="true" />
      )}
      <span className="flex-1">{offline ? messageOffline : messageQueue}</span>
      {/* `pending` is included in the queue message via t("queuePending"); kept
       *  as a separate prop so this component is trivial to render-test. */}
      <span className="sr-only">{pending}</span>
    </motion.div>
  )
}
