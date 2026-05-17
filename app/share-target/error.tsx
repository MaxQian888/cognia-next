"use client"

/**
 * Error boundary for the /share-target route. Delegates layout to the shared
 * `ErrorPage`; share-target keeps its mobile-specific copy via the existing
 * `mobile.shareTarget` namespace and logs against the native scope.
 */

import { useTranslations } from "next-intl"

import { ErrorPage } from "@/components/error/error-page"

export default function ShareTargetError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  const t = useTranslations("mobile.shareTarget")
  return (
    <ErrorPage
      variant="error"
      error={error}
      reset={reset}
      title={t("errorTitle")}
      description={t("errorDescription")}
      subsystem="native"
    />
  )
}
