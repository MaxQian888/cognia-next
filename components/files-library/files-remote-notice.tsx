"use client"

/**
 * The notice a paired device's Files page shows when its last read of the
 * host's library failed (ADR-0223 §9). What was already on screen stays; the
 * notice says why it may be stale and offers Retry. Nothing renders while
 * the library reads fine, or where it is this device's own (no `refresh`).
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { CloudOffIcon, RotateCwIcon } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export function FilesRemoteNotice({
  error,
  refresh,
  touch = false,
  className,
}: {
  /** The `files.errors.*` code of the failed read. */
  error: string | undefined
  refresh: (() => Promise<void>) | undefined
  /** Touch-sized Retry. */
  touch?: boolean
  className?: string
}) {
  const t = useTranslations("files")
  const [retrying, setRetrying] = useState(false)
  if (!error || !refresh) return null
  const key = `errors.${error}`
  const reason = t.has(key) ? t(key) : t("errors.unknown")
  return (
    <Alert
      variant="destructive"
      className={cn("items-center", className)}
      data-testid="files-remote-notice"
    >
      <CloudOffIcon aria-hidden />
      <AlertTitle>{t("remote.loadFailed")}</AlertTitle>
      <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
        <span>{reason}</span>
        <Button
          variant="outline"
          size={touch ? "default" : "sm"}
          className={cn(touch && "h-10")}
          disabled={retrying}
          onClick={() => {
            setRetrying(true)
            void refresh().finally(() => setRetrying(false))
          }}
          data-testid="files-remote-retry"
        >
          <RotateCwIcon className={cn(retrying && "animate-spin")} aria-hidden />
          {t("remote.retry")}
        </Button>
      </AlertDescription>
    </Alert>
  )
}
