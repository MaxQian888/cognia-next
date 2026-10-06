"use client"

import { ExternalLinkIcon, RotateCwIcon, UnplugIcon } from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"

/** A failed web page is recoverable without resetting the application route. */
export function BrowserLoadError({
  url,
  message,
  timedOut = false,
  onRetry,
  onEditAddress,
  onOpenExternal,
  onContinue,
}: {
  url: string
  message?: string | null
  timedOut?: boolean
  onRetry: () => void
  onEditAddress?: () => void
  onOpenExternal?: () => void
  onContinue?: () => void
}) {
  const t = useTranslations("browser.loadError")
  const actionsT = useTranslations("browser.actions")
  return (
    <div
      role="alert"
      className="flex h-full min-h-0 min-w-0 flex-col overflow-y-auto bg-background p-5"
      data-testid="browser-load-error"
    >
      <div className="my-auto flex w-full min-w-0 shrink-0 flex-col items-center gap-4 py-4 text-center">
        <div className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-muted">
          <UnplugIcon className="size-5 text-muted-foreground" aria-hidden />
        </div>
        <div className="w-full max-w-sm space-y-2">
          <h2 className="text-sm font-medium">{t(timedOut ? "timeoutTitle" : "title")}</h2>
          <p className="break-all text-xs text-muted-foreground">{url}</p>
          <p className="break-words text-xs text-muted-foreground">
            {message || t(timedOut ? "timeoutHint" : "hint")}
          </p>
        </div>
        <div className="flex max-w-full flex-wrap justify-center gap-2">
          <Button
            size="sm"
            className="h-auto min-h-8 max-w-full whitespace-normal py-1.5"
            onClick={onRetry}
          >
            <RotateCwIcon aria-hidden />
            {t("retry")}
          </Button>
          {onEditAddress && (
            <Button
              size="sm"
              variant="outline"
              className="h-auto min-h-8 max-w-full whitespace-normal py-1.5"
              onClick={onEditAddress}
            >
              {t("editAddress")}
            </Button>
          )}
        </div>
        {(onOpenExternal || onContinue) && (
          <div className="flex max-w-full flex-wrap justify-center gap-1">
            {onOpenExternal && (
              <Button
                size="sm"
                variant="ghost"
                className="h-auto min-h-8 max-w-full whitespace-normal py-1.5"
                onClick={onOpenExternal}
              >
                <ExternalLinkIcon aria-hidden />
                {actionsT("openExternal")}
              </Button>
            )}
            {onContinue && (
              <Button
                size="sm"
                variant="ghost"
                className="h-auto min-h-8 max-w-full whitespace-normal py-1.5"
                onClick={onContinue}
              >
                {t("continue")}
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
