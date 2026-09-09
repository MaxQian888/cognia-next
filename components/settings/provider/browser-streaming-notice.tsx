"use client"

/**
 * Tells a standalone (BYOK) session whether this provider's endpoint will
 * actually stream from the browser it is running in.
 *
 * Only shown when chat really does run in this webview against the user's own
 * key. On a paired phone every turn goes through the desktop sidecar, so the
 * browser's CORS rules have nothing to do with it, and the old mobile page's
 * advice was simply wrong on a paired device.
 *
 * The predicate is `isStandaloneChatMode()` rather than the host profile:
 * `detectHostProfile()` answers "mobile-companion" for any Capacitor shell
 * whether or not it has ever been paired.
 */

import { AlertTriangle, Zap } from "lucide-react"
import { useTranslations } from "next-intl"

import { isStandaloneChatMode } from "@/lib/runtime/standalone-mode"
import { streamsDirectFromBrowser } from "@/lib/runtime/streaming-fetch"
import { useSettingsStore } from "@/stores/settings"

export interface BrowserStreamingNoticeProps {
  providerId: string
  /** A stored custom endpoint, which makes the CORS answer unknowable. */
  baseURL?: string
}

export function BrowserStreamingNotice({ providerId, baseURL }: BrowserStreamingNoticeProps) {
  const t = useTranslations("providers.browserStreaming")
  // `isStandaloneChatMode` is a synchronous store read, so subscribe to the
  // one setting that can flip it and let that drive the re-render.
  useSettingsStore((s) => s.settings?.mobileRuntimeMode)

  if (!isStandaloneChatMode()) return null

  const supported = streamsDirectFromBrowser(providerId)
  const custom = Boolean(baseURL?.trim())

  // A custom endpoint outranks the built-in answer: the list is about the
  // provider's official origin, and a gateway's CORS policy is its own.
  const tone = supported && !custom ? "info" : "warn"
  const key = custom ? "gateway" : supported ? "supported" : "unsupported"

  return (
    <div
      data-testid="browser-streaming-notice"
      data-tone={tone}
      className={
        tone === "info"
          ? "flex items-start gap-3 rounded-md border border-border bg-muted/40 px-3 py-2.5"
          : "flex items-start gap-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 dark:border-amber-900 dark:bg-amber-950/30"
      }
    >
      {tone === "info" ? (
        <Zap className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      ) : (
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
      )}
      <div className="min-w-0 flex-1">
        <p
          className={
            tone === "info"
              ? "text-sm font-medium"
              : "text-sm font-medium text-amber-700 dark:text-amber-400"
          }
        >
          {t(`${key}Title`)}
        </p>
        <p
          className={
            tone === "info"
              ? "mt-0.5 text-xs text-muted-foreground"
              : "mt-0.5 text-xs text-amber-600 dark:text-amber-500"
          }
        >
          {t(`${key}Description`)}
        </p>
      </div>
    </div>
  )
}
