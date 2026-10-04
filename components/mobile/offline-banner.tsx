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
 * The queue state comes from `useOutboundQueueStatus` (a Dexie live query, shared
 * with the composer strip), so newly enqueued and
 * drained rows update the banner reactively rather than on a polling timer.
 *
 * On a paired device the network being up says nothing about the Host: the
 * phone's Wi-Fi is fine while the desktop sleeps or the cloud Host redeploys.
 * The runtime snapshot's `connectionState` is the Host-side answer, so the
 * banner reads it too — "reconnecting" while the transport is re-dialling,
 * and the offline copy once it has given up — but only for a companion
 * target: a standalone tab has no Host to be disconnected from, and the
 * empty snapshot reports `offline` by construction.
 *
 * On the compact shell this is the ONE connection report: it also carries what
 * the state means for the route under it ("cached data only" on a read-only
 * route, which the boundary used to say in a second band right below) and the
 * way to the connection settings. Drawn with the shared `RuntimeStatusBand`.
 */

import { useEffect, useState, useSyncExternalStore } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { useTranslations } from "next-intl"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"

import {
  RUNTIME_BAND_ACTION,
  RuntimeStatusBand,
  type RuntimeStatusTone,
} from "@/components/runtime/runtime-status-band"
import { useNetworkStatus } from "@/hooks/use-network-status"
import { usePlatform } from "@/hooks/use-platform"
import { useRuntimeSnapshot } from "@/hooks/use-runtime-snapshot"
import { useCompactLayout } from "@/hooks/ui/use-compact-layout"
import { useOutboundQueueStatus } from "@/hooks/use-outbound-queue-status"
import { registerOutboundApprovalReporter } from "@/lib/queue/outbound-approval"
import {
  isConnectionNoticeClaimed,
  isQueueNoticeClaimed,
  subscribeConnectionNoticeClaim,
} from "@/lib/runtime/connection-notice-claim"
import { resolveRuntimeRecovery } from "@/lib/runtime/recovery-resolver"
import {
  getSurfaceContractForRoute,
  isInternalRouteExempt,
  resolveSurfaceAvailability,
} from "@/lib/runtime/surface-contract"
import { MOBILE_DURATION, MOBILE_EASE } from "@/lib/ui/motion"
import { cn } from "@/lib/utils"
import { OutboundQueueSheet } from "./outbound-queue-sheet"

export interface OfflineBannerProps {
  className?: string
}

export function OfflineBanner({ className }: OfflineBannerProps) {
  const t = useTranslations("mobile.offline")
  const compact = useCompactLayout()
  const platform = usePlatform()
  const pathname = usePathname()
  const { status, loading } = useNetworkStatus()
  const runtime = useRuntimeSnapshot()
  // Claim the approval wait for as long as this banner is mounted, so the
  // runner's fallback toast stays out of the way here and fires on every shell
  // that does NOT mount this banner, which is all of them but the mobile ones.
  useEffect(() => registerOutboundApprovalReporter(), [])
  const queue = useOutboundQueueStatus()
  const [reviewOpen, setReviewOpen] = useState(false)
  // While the chat's runtime notice is mounted it reports the Host connection
  // itself, with the recovery action (`connection-notice-claim.ts`), and the
  // composer strip carries the queue on the same line — each half of this
  // banner stands down for the half that is claimed. A route the boundary
  // blocks outright for being offline claims the connection the same way: its
  // page IS the report.
  const connectionClaimed = useSyncExternalStore(
    subscribeConnectionNoticeClaim,
    isConnectionNoticeClaimed,
    () => false
  )
  const queueClaimed = useSyncExternalStore(
    subscribeConnectionNoticeClaim,
    isQueueNoticeClaimed,
    () => false
  )

  if (!compact) return null
  if (loading) return null

  const companion = runtime.target?.kind === "companion"
  const hostState = companion ? runtime.connectionState : "online"
  const hostOffline = !connectionClaimed && status.connected && hostState === "offline"
  // A paired Host that is answering proves the network works. Android reports
  // `connected: false` for Wi-Fi without validated Internet — exactly a LAN
  // with a desktop on it — so on a companion target an online Host outranks
  // the device's own verdict. A standalone tab has no such witness.
  const hostAnswering = companion && hostState === "online"
  const offline = !connectionClaimed && ((!status.connected && !hostAnswering) || hostOffline)
  const reconnecting = !connectionClaimed && !offline && hostState === "connecting"
  const showQueue = !queueClaimed && queue.visible
  const visible = offline || reconnecting || showQueue

  // What the page under the banner can still do. The route boundary used to
  // say "Read-only mode: …" in a second band of its own right under this one;
  // on the compact shell that half of the report rides here instead, so one
  // line says both what happened and what it means for this screen.
  const contract =
    visible && pathname && !isInternalRouteExempt(pathname)
      ? getSurfaceContractForRoute(pathname)
      : null
  // Only the cache fallback: any other read-only reason (a legacy data space,
  // an operation the Host lacks) is not a connection report, and the boundary
  // keeps saying it itself.
  const routeAvailability = contract ? resolveSurfaceAvailability(contract, runtime) : null
  const routeReadOnly =
    routeAvailability?.state === "read-only" && routeAvailability.reason === "offline-cache"

  const connectionLine = offline || reconnecting
  const stuck = showQueue && queue.stuck > 0
  const tone: RuntimeStatusTone = offline
    ? "offline"
    : reconnecting
      ? "progress"
      : stuck
        ? // Not a spinner: nothing is retrying these, and an animation that
          // says "working on it" is the wrong thing to show for work that has
          // stopped.
          "attention"
        : "progress"
  const title = offline
    ? hostOffline
      ? t("stateHostOffline")
      : t("stateNetworkOffline")
    : reconnecting
      ? t("stateReconnecting")
      : queue.message
  // The queue says more than any generic consequence: that sends are waiting,
  // or that some stopped and need a decision.
  const detail = !connectionLine
    ? undefined
    : showQueue
      ? queue.message
      : routeReadOnly
        ? t("detailCacheOnly")
        : offline
          ? hostOffline
            ? t("detailHostOffline")
            : t("detailNetworkOffline")
          : undefined
  // The way back, on the band itself: the screens behind a dead Host used to
  // offer none, and the connection settings sat behind an "offline" page.
  // Only for the Host — a phone with no network has nothing to configure.
  const recovery =
    connectionLine && companion && (hostOffline || reconnecting)
      ? resolveRuntimeRecovery({ state: "offline", reason: "connection-offline" }, platform)
      : null
  const recoveryHref = recovery?.kind === "route" ? recovery.href : null
  // A count was all this banner could say about the queue, with nowhere to see
  // or take back what it counted. Rows exist → offer the list.
  const canReview = showQueue && queue.hasRows

  return (
    <>
      <AnimatePresence initial={false}>
        {visible ? (
        <BannerFrame
          key="offline-banner"
          offline={offline}
          hostOffline={hostOffline}
          reconnecting={reconnecting}
          stuck={stuck}
          className={className}
        >
          <RuntimeStatusBand
            tone={tone}
            title={title}
            detail={detail}
            detailAttention={connectionLine && stuck}
            actions={
              canReview || recoveryHref ? (
                <>
                  {canReview ? (
                    <button
                      type="button"
                      onClick={() => setReviewOpen(true)}
                      className={RUNTIME_BAND_ACTION}
                      data-testid="offline-banner-review"
                    >
                      {t("review")}
                    </button>
                  ) : null}
                  {recoveryHref ? (
                    <Link
                      href={recoveryHref}
                      className={RUNTIME_BAND_ACTION}
                      data-testid="offline-banner-recovery"
                    >
                      {t("connectionSettings")}
                    </Link>
                  ) : null}
                </>
              ) : undefined
            }
          />
          {/* `pending` is part of the queue sentence via t("queuePending"); kept
              as a separate node so the count is trivial to render-test. */}
          <span className="sr-only">{showQueue ? queue.pending : 0}</span>
        </BannerFrame>
        ) : null}
      </AnimatePresence>
      <OutboundQueueSheet open={reviewOpen} onOpenChange={setReviewOpen} />
    </>
  )
}

interface BannerFrameProps {
  offline: boolean
  /** The device network is up but the paired Host is not answering. */
  hostOffline: boolean
  reconnecting: boolean
  stuck: boolean
  className?: string
  children: React.ReactNode
}

/** The sticky, animated row the band rides in, with the state as data attributes. */
function BannerFrame({
  offline,
  hostOffline,
  reconnecting,
  stuck,
  className,
  children,
}: BannerFrameProps) {
  const reduce = useReducedMotion()
  return (
    <motion.div
      role="status"
      aria-live="polite"
      data-testid="offline-banner"
      data-offline={offline ? "true" : "false"}
      data-host-offline={hostOffline ? "true" : "false"}
      data-reconnecting={reconnecting ? "true" : "false"}
      data-stuck={stuck ? "true" : "false"}
      initial={reduce ? false : { opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={reduce ? { opacity: 0 } : { opacity: 0, y: -8 }}
      transition={{
        duration: MOBILE_DURATION.fast,
        ease: MOBILE_EASE,
      }}
      className={cn("sticky top-0 z-30", className)}
    >
      {children}
    </motion.div>
  )
}
