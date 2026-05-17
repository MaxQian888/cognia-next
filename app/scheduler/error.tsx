"use client"

/**
 * Error boundary for the /scheduler route. Delegates layout to the shared
 * `ErrorPage` so retry / home / crash-log export are consistent with the rest
 * of the app; the scheduler-specific copy and logger scope are passed through.
 */

import { useTranslations } from "next-intl"

import { ErrorPage } from "@/components/error/error-page"

export default function SchedulerError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  const t = useTranslations("scheduler")
  return (
    <ErrorPage
      variant="error"
      error={error}
      reset={reset}
      title={t("errorTitle")}
      description={t("errorDescription")}
      subsystem="scheduler"
    />
  )
}
