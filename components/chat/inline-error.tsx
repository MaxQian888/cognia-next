"use client"

import { useTranslations } from "next-intl"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { AlertCircleIcon, RefreshCwIcon, SettingsIcon } from "lucide-react"

interface Props {
  message: string
  onRetry?: () => void | Promise<void>
  onOpenSettings?: () => void
  onDismiss?: () => void
}

/**
 * Inline error banner shown after the last user message when a send fails.
 * Offers retry + a quick jump to settings (useful for "no API key" failures).
 */
export function InlineError({ message, onRetry, onOpenSettings, onDismiss }: Props) {
  const t = useTranslations("chat.inlineError")
  const isApiKey = /api[\s_-]?key/i.test(message)
  return (
    <Alert variant="destructive" className="mx-4 mt-2">
      <AlertCircleIcon className="size-4" />
      <AlertTitle className="text-sm">{t("title")}</AlertTitle>
      <AlertDescription className="space-y-2 text-xs">
        <p className="break-words">{message}</p>
        <div className="flex flex-wrap gap-2 pt-1">
          {onRetry && (
            <Button variant="outline" size="sm" onClick={() => void onRetry()}>
              <RefreshCwIcon className="mr-1.5 size-3.5" />
              {t("retry")}
            </Button>
          )}
          {(isApiKey || !onRetry) && onOpenSettings && (
            <Button variant="outline" size="sm" onClick={onOpenSettings}>
              <SettingsIcon className="mr-1.5 size-3.5" />
              {t("openSettings")}
            </Button>
          )}
          {onDismiss && (
            <Button variant="ghost" size="sm" onClick={onDismiss}>
              {t("dismiss")}
            </Button>
          )}
        </div>
      </AlertDescription>
    </Alert>
  )
}
