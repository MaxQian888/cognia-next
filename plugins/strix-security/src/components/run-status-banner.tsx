"use client"

import { AlertCircle, Ban, Loader2 } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@cognia/plugin-ui"
import type { StrixRun } from "../types"
import { runErrorText } from "../lib/run-error"
import { usePluginTranslations } from "@cognia/plugin-sdk/api/i18n"
import { PLUGIN_ID } from "../ids"

interface Props {
  run: StrixRun
}

/**
 * Outcome context for the selected run.
 *
 * Findings alone cannot explain a run: a failed scan and a clean scan both
 * show an empty list, and "running" used to look identical to "found
 * nothing". The banner is what makes those states distinguishable.
 *
 * A `done` run (even a clean one) needs no banner — the findings list says it
 * all. `reportUnreadable` is folded into the run's error code by the runner,
 * and every reason is translated from its code at render time.
 */
export function RunStatusBanner({ run }: Props) {
  const t = usePluginTranslations(PLUGIN_ID)
  const reason = runErrorText(run, t)

  if (run.status === "running") {
    return (
      <Alert
        className="border-info/40 bg-info/10 py-2 text-xs text-info"
        data-testid="strix-run-running"
      >
        <Loader2 className="animate-spin motion-reduce:animate-none" />
        <AlertTitle className="line-clamp-none font-normal">
          {t("run.scanning", { target: run.target })}
        </AlertTitle>
      </Alert>
    )
  }

  if (run.status === "error") {
    return (
      <Alert variant="destructive" data-testid="strix-run-error">
        <AlertCircle className="size-4" />
        <AlertTitle>{t("run.failed")}</AlertTitle>
        {reason && <AlertDescription className="whitespace-pre-wrap">{reason}</AlertDescription>}
      </Alert>
    )
  }

  if (run.status === "cancelled") {
    return (
      <Alert className="py-2 text-xs text-muted-foreground" data-testid="strix-run-cancelled">
        <Ban />
        <AlertTitle className="line-clamp-none font-normal">{t("run.cancelled")}</AlertTitle>
        {reason && (
          <AlertDescription className="whitespace-pre-wrap text-muted-foreground">
            {reason}
          </AlertDescription>
        )}
      </Alert>
    )
  }

  return null
}
