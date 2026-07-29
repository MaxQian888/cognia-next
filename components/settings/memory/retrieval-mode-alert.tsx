"use client"

/**
 * Tells the user what recall is *actually* doing, and offers the one action that
 * would fix it.
 *
 * This exists because `hybridEnabled: true` is not sufficient: three further
 * conditions silently drop recall to keyword-only, and one of them —
 * `allowCloudEmbedding: false` against a cloud embedder — is the default for
 * anyone who did not configure a local model. Before this, the pane said
 * "Hybrid retrieval: on" while the runtime had been BM25-only forever.
 */

import Link from "next/link"
import { AnimatePresence, motion } from "motion/react"
import { useTranslations } from "next-intl"
import { CheckCircle2Icon, ExternalLinkIcon, TriangleAlertIcon } from "lucide-react"

import { MOBILE_DURATION, MOBILE_EASE } from "@/lib/ui/motion"
import { useFlowMotion } from "@/components/chat/motion/motion-reveal"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import type { MemoryRetrievalMode } from "@/lib/memory/runtime/build-deps"

export interface RetrievalModeAlertProps {
  mode: MemoryRetrievalMode | undefined
  /** Flip `hybridEnabled` / `allowCloudEmbedding` in place. */
  onEnableHybrid: () => void
  onAllowCloudEmbedding: () => void
  /** Hide the "all good" state where a green banner would just be noise. */
  quietWhenHealthy?: boolean
}

export function RetrievalModeAlert({
  mode,
  onEnableHybrid,
  onAllowCloudEmbedding,
  quietWhenHealthy,
}: RetrievalModeAlertProps) {
  const t = useTranslations("settings.memory.retrievalMode")
  const { reduce, durationScale } = useFlowMotion()

  if (mode === undefined) {
    return <Skeleton className="h-16 w-full rounded-lg" data-testid="memory-retrieval-probing" />
  }

  // Memory is off entirely — the master switch already says so; a degradation
  // warning on top of it would be noise about a system that is not running.
  if (mode.kind === "off") return null

  const healthy = mode.kind === "hybrid"
  if (healthy && quietWhenHealthy) return null

  const body = healthy ? (
    <div
      className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3"
      data-testid="memory-retrieval-alert"
      data-mode="hybrid"
    >
      <CheckCircle2Icon className="size-4 shrink-0 text-emerald-600 dark:text-emerald-500" />
      <p className="text-xs text-muted-foreground">{t("hybrid", { provider: mode.provider })}</p>
    </div>
  ) : (
    <div
      className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3"
      data-testid="memory-retrieval-alert"
      data-mode="bm25"
      data-reason={mode.reason}
      role="status"
    >
      <div className="flex items-start gap-2">
        <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-500" />
        <div className="min-w-0 space-y-0.5">
          <p className="text-sm font-medium">{t("degradedTitle")}</p>
          <p className="text-xs text-muted-foreground">
            {t(`reasons.${mode.reason}`, { provider: mode.provider ?? "" })}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2 pl-6">
        {mode.reason === "hybrid_disabled" ? (
          <Button size="sm" variant="outline" onClick={onEnableHybrid}>
            {t("actions.enableHybrid")}
          </Button>
        ) : null}
        {mode.reason === "cloud_blocked" ? (
          <Button size="sm" variant="outline" onClick={onAllowCloudEmbedding}>
            {t("actions.allowCloud")}
          </Button>
        ) : null}
        {mode.reason === "no_backend" || mode.reason === "store_unsupported" ? (
          <Button size="sm" variant="outline" asChild>
            <Link href="/settings?section=providers">
              <ExternalLinkIcon className="size-3.5" />
              {t("actions.configureEmbedding")}
            </Link>
          </Button>
        ) : null}
      </div>
    </div>
  )

  if (reduce) return body

  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={healthy ? "hybrid" : mode.reason}
        initial={{ opacity: 0, y: -4 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -4 }}
        transition={{ duration: MOBILE_DURATION.fast * durationScale, ease: MOBILE_EASE }}
      >
        {body}
      </motion.div>
    </AnimatePresence>
  )
}
