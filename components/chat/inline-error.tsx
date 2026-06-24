"use client"

import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { ErrorParsedView } from "@/components/chat/error-parsed-view"
import { AlertTriangleIcon, RefreshCwIcon, SettingsIcon, XIcon } from "lucide-react"

interface Props {
  message: string
  onRetry?: () => void | Promise<void>
  onOpenSettings?: () => void
  onDismiss?: () => void
}

/**
 * Inline error banner shown after the last user message when a send fails.
 * Offers retry + a quick jump to settings (useful for "no API key" failures).
 *
 * The body delegates to `ErrorParsedView`, which turns raw provider/transport
 * errors into a category badge, hint and (when present) a navigable stack —
 * this component just frames it as a calm, readable card rather than a wall of
 * red text.
 */
export function InlineError({ message, onRetry, onOpenSettings, onDismiss }: Props) {
  const t = useTranslations("chat.inlineError")
  const isApiKey = /api[\s_-]?key/i.test(message)
  const showSettings = (isApiKey || !onRetry) && Boolean(onOpenSettings)
  const hasActions = Boolean(onRetry) || showSettings || Boolean(onDismiss)

  return (
    <div
      role="alert"
      data-testid="inline-error"
      className="mx-4 mt-2 overflow-hidden rounded-xl border border-destructive/30 bg-destructive/[0.06] shadow-sm"
    >
      <div className="flex gap-3 p-3">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-destructive/15 text-destructive">
          <AlertTriangleIcon className="size-4" aria-hidden />
        </div>
        <div className="min-w-0 flex-1 space-y-1.5">
          <p className="text-sm font-medium text-destructive">{t("title")}</p>
          <div className="text-xs leading-relaxed text-foreground/80">
            <ErrorParsedView rawError={message} fallback={message} />
          </div>
        </div>
      </div>

      {hasActions && (
        <div className="flex flex-wrap items-center gap-2 border-t border-destructive/15 bg-destructive/[0.03] px-3 py-2">
          {onRetry && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1.5"
              onClick={() => void onRetry()}
            >
              <RefreshCwIcon className="size-3.5" aria-hidden />
              {t("retry")}
            </Button>
          )}
          {showSettings && (
            <Button variant="outline" size="sm" className="h-7 gap-1.5" onClick={onOpenSettings}>
              <SettingsIcon className="size-3.5" aria-hidden />
              {t("openSettings")}
            </Button>
          )}
          {onDismiss && (
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto h-7 gap-1.5 text-muted-foreground hover:text-foreground"
              onClick={onDismiss}
            >
              <XIcon className="size-3.5" aria-hidden />
              {t("dismiss")}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
