"use client"

/**
 * Error boundary for the /scheduler route. Cognia uses ai-elements'
 * `StackTrace` group for collapsible / copyable stack rendering; cognia-next
 * doesn't ship that component, so we fall back to a `<pre>` block. The rest
 * of the layout stays identical so users see a consistent failure mode.
 */

import { useEffect } from "react"
import { useTranslations } from "next-intl"
import { AlertTriangle, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { loggers } from "@/lib/logger"

export default function SchedulerError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  const t = useTranslations("scheduler")
  const errorTrace =
    error.stack || [error.name, error.message].filter(Boolean).join(": ") || "Error"

  useEffect(() => {
    loggers.scheduler.error("Scheduler page error", error)
  }, [error])

  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="max-w-xl text-center space-y-4">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-destructive/10">
          <AlertTriangle className="h-8 w-8 text-destructive" />
        </div>
        <h2 className="text-lg font-semibold">{t("errorTitle") || "Something went wrong"}</h2>
        <p className="text-sm text-muted-foreground">
          {t("errorDescription") ||
            "The scheduler encountered an unexpected error. This may be caused by a database issue or corrupted data."}
        </p>
        {errorTrace && (
          <pre className="text-xs text-left bg-muted/40 border rounded-md p-3 max-h-60 overflow-auto whitespace-pre-wrap">
            {errorTrace}
          </pre>
        )}
        <Button onClick={reset} className="gap-2">
          <RefreshCw className="h-4 w-4" />
          {t("retry") || "Try again"}
        </Button>
      </div>
    </div>
  )
}
