"use client"

/**
 * Offline / queue banner (Wave 3.5).
 *
 * Shows above all routed content when:
 *   - The network is offline, OR
 *   - The mobile outbound queue has pending rows (regardless of network).
 *
 * On non-mobile platforms it stays hidden (`usePlatform()` gate). The
 * banner self-refreshes every 15 s to pick up newly enqueued rows.
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { CloudOffIcon, LoaderIcon } from "lucide-react"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"

import { useNetworkStatus } from "@/hooks/use-network-status"
import { usePlatform } from "@/hooks/use-platform"
import { getQueueSummary } from "@/lib/queue/outbound-queue"
import { MOBILE_DURATION, MOBILE_EASE } from "@/lib/ui/motion"
import { cn } from "@/lib/utils"

const POLL_MS = 15_000

export interface OfflineBannerProps {
  className?: string
}

export function OfflineBanner({ className }: OfflineBannerProps) {
  const t = useTranslations("mobile.offline")
  const platform = usePlatform()
  const { status, loading } = useNetworkStatus()
  const [pending, setPending] = useState<number>(0)

  useEffect(() => {
    if (platform !== "mobile") return
    let cancelled = false
    const tick = async () => {
      try {
        const summary = await getQueueSummary()
        if (!cancelled) setPending(summary.pending + summary.failed)
      } catch {
        // Best effort.
      }
    }
    void tick()
    const id = window.setInterval(() => void tick(), POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [platform])

  if (platform !== "mobile") return null
  if (loading) return null

  const offline = !status.connected
  const showQueue = pending > 0
  const visible = offline || showQueue

  return (
    <AnimatePresence initial={false}>
      {visible ? (
        <BannerBody
          offline={offline}
          pending={pending}
          messageOffline={t("bannerOffline")}
          messageQueue={t("queuePending", { count: pending })}
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
        ease: MOBILE_EASE as unknown as number[],
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
