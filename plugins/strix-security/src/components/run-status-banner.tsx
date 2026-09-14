"use client"

import { AlertCircle, Ban, Loader2 } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@cognia/plugin-ui"
import type { StrixRun } from "../types"
import { usePluginT } from "../use-plugin-t"

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
 * all. `reportUnreadable` is folded into `error` by the runner already.
 */
export function RunStatusBanner({ run }: Props) {
  const t = usePluginT()

  if (run.status === "running") {
    return (
      <Alert
        className="border-sky-500/40 bg-sky-500/10 py-2 text-xs text-sky-700 dark:text-sky-400"
        data-testid="strix-run-running"
      >
        <Loader2 className="animate-spin" />
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
        {run.error && (
          <AlertDescription className="whitespace-pre-wrap">{run.error}</AlertDescription>
        )}
      </Alert>
    )
  }

  if (run.status === "cancelled") {
    return (
      <Alert className="py-2 text-xs text-muted-foreground" data-testid="strix-run-cancelled">
        <Ban />
        <AlertTitle className="line-clamp-none font-normal">{t("run.cancelled")}</AlertTitle>
        {run.error && (
          <AlertDescription className="whitespace-pre-wrap text-muted-foreground">
            {run.error}
          </AlertDescription>
        )}
      </Alert>
    )
  }

  return null
}
