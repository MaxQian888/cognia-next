"use client"

/**
 * Automatic crash-report submission, mounted for the app's lifetime (ADR-0102).
 *
 * Renderless apart from its receipts: one pass per launch for the unlocked
 * account (`useDiagnosticAutoSubmit`), and a toast per report it sent carrying
 * the support code — the receipt a user quotes to support, and the proof the
 * switch they turned on in Settings did something. Failures say so too, with
 * whether a later launch will try again, instead of failing silently in a
 * setting nobody re-reads.
 *
 * Mount it once per main window on the desktop and on mobile (the plain
 * browser has no submission path and the pass ends at the runtime probe).
 */

import { useCallback } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import {
  useDiagnosticAutoSubmit,
  type DiagnosticAutoSubmitDeps,
} from "@/hooks/diagnostic-service/use-diagnostic-auto-submit"
import type { AutoSubmitOutcome } from "@/lib/diagnostic-service/auto-submit"

/** Where the receipts live. */
export const CRASH_REPORTS_HREF = "/logs?channel=incidents"

export function DiagnosticAutoSubmitInitializer({ deps }: { deps?: DiagnosticAutoSubmitDeps }) {
  const t = useTranslations("logging.autoSubmit")
  const router = useRouter()

  const onOutcomes = useCallback(
    (outcomes: AutoSubmitOutcome[]) => {
      const view = { label: t("view"), onClick: () => router.push(CRASH_REPORTS_HREF) }
      for (const outcome of outcomes) {
        if (outcome.kind === "submitted") {
          toast.success(t("sent", { code: outcome.receipt.supportCode }), {
            description: t("sentDescription"),
            action: view,
          })
        }
      }
      const failed = outcomes.filter((outcome) => outcome.kind === "failed")
      if (failed.length > 0) {
        const retrying = failed.some((outcome) => outcome.kind === "failed" && outcome.willRetry)
        toast.warning(t("failed", { count: failed.length }), {
          description: retrying ? t("failedRetry") : t("failedFinal"),
          action: view,
        })
      }
    },
    [router, t]
  )

  useDiagnosticAutoSubmit({ onOutcomes, deps })
  return null
}

export default DiagnosticAutoSubmitInitializer
