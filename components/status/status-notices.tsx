"use client"

/**
 * Page-level notices: the read-only mirror warning and the refresh-failure
 * banner shown while the last validated snapshot stays on screen.
 */

import { useLocale, useTranslations } from "next-intl"
import { CloudOffIcon, CopyIcon, RefreshCwIcon } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import type { PublicStatusError } from "@/hooks/status/use-public-status"
import type { StatusRuntime } from "@/lib/status/public-status"
import { cn } from "@/lib/utils"

import { StatusExternalLink } from "./status-link"
import { formatUtcDateTime } from "./status-format"

export function MirrorNotice({ runtime }: { runtime: StatusRuntime }) {
  const t = useTranslations("publicStatus.mirror")
  if (runtime.mode !== "mirror") return null
  return (
    <Alert
      className="border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-100"
      data-testid="mirror-notice"
    >
      <CopyIcon aria-hidden />
      <AlertTitle>{t("title")}</AlertTitle>
      <AlertDescription className="text-amber-900/90 dark:text-amber-100/90">
        <p>{t("description")}</p>
        <StatusExternalLink
          href={runtime.primaryPageUrl}
          mode={runtime.mode}
          className="font-medium underline"
        >
          {t("openPrimary")}
        </StatusExternalLink>
      </AlertDescription>
    </Alert>
  )
}

export function RefreshErrorBanner({
  error,
  fetchedAtClientMs,
  onRetry,
  refreshing,
}: {
  error: PublicStatusError
  /** When the snapshot still on screen was received (client clock). */
  fetchedAtClientMs: number
  onRetry: () => void
  refreshing: boolean
}) {
  const t = useTranslations("publicStatus")
  const locale = useLocale()
  return (
    <Alert variant="destructive" role="alert" data-testid="refresh-error" data-kind={error.kind}>
      <CloudOffIcon aria-hidden />
      <AlertTitle>{t("error.bannerTitle")}</AlertTitle>
      <AlertDescription>
        <p>
          {t(`error.kinds.${error.kind}`)}{" "}
          {t("error.bannerDescription", {
            time: formatUtcDateTime(new Date(fetchedAtClientMs).toISOString(), locale),
          })}
        </p>
        {error.kind === "unsupported" ? (
          <Button
            variant="outline"
            size="sm"
            className="mt-2"
            onClick={() => window.location.reload()}
          >
            <RefreshCwIcon aria-hidden />
            {t("actions.reload")}
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            className="mt-2"
            onClick={onRetry}
            disabled={refreshing}
          >
            <RefreshCwIcon className={cn(refreshing && "motion-safe:animate-spin")} aria-hidden />
            {t("actions.retry")}
          </Button>
        )}
      </AlertDescription>
    </Alert>
  )
}
