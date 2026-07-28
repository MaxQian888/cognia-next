"use client"

/**
 * Persistent notice for the one failure the app used to hide completely:
 * `useSettingsStore.load()` threw, so the session is running on `DEFAULTS`.
 *
 * Before this existed the catch branch only wrote to `console.error`. The user
 * saw an app with no provider, no API key and a reset theme, indistinguishable
 * from a fresh install — and every subsequent "why is my key gone?" was
 * unanswerable. Persistence itself stays safe (`saveSettings` re-reads the row
 * from Dexie inside its retry wrapper and merges onto *that*, never onto the
 * in-memory defaults), so the fix is disclosure plus a retry, not a lock.
 *
 * Deliberately NOT dismissible: the degraded state lasts until a load
 * succeeds, and a dismissed banner would put the user right back in the dark.
 * It self-hides the moment `retryLoad()` works.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { LoaderIcon, RefreshCwIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { NoticeItem } from "@/components/inbox/notices/notice-item"
import { useSettingsStore } from "@/stores/settings"

export function SettingsLoadFailedBanner() {
  const t = useTranslations("diagnostics.surface.settingsLoadFailed")
  const loadFailed = useSettingsStore((s) => s.loadFailed)
  const loadError = useSettingsStore((s) => s.loadError)
  const [retrying, setRetrying] = useState(false)

  if (!loadFailed) return null

  const onRetry = async () => {
    setRetrying(true)
    try {
      await useSettingsStore.getState().retryLoad()
    } finally {
      // `retryLoad` never throws — it funnels back through `load`'s own catch,
      // which re-sets `loadFailed`. If it failed again the banner simply stays.
      setRetrying(false)
    }
  }

  return (
    <div
      data-testid="settings-load-failed-banner"
      className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex justify-center p-3"
    >
      <div className="pointer-events-auto w-full max-w-2xl rounded-lg border border-destructive/30 bg-background/95 py-1 shadow-lg backdrop-blur">
        <NoticeItem
          severity="danger"
          title={t("title")}
          actions={
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-6 px-2 text-[11px]"
              disabled={retrying}
              onClick={() => void onRetry()}
              data-testid="settings-load-failed-retry"
            >
              {retrying ? (
                <LoaderIcon className="mr-1 size-3 animate-spin" aria-hidden />
              ) : (
                <RefreshCwIcon className="mr-1 size-3" aria-hidden />
              )}
              {retrying ? t("retrying") : t("retry")}
            </Button>
          }
        >
          <p className="mt-0.5 text-muted-foreground">{t("body")}</p>
          {loadError && (
            <details className="mt-1">
              <summary className="cursor-pointer text-[11px] text-muted-foreground hover:text-foreground">
                {t("detailsLabel")}
              </summary>
              <pre
                className="mt-1 max-h-24 overflow-auto rounded bg-muted/40 p-1.5 text-[11px] leading-relaxed font-mono"
                data-testid="settings-load-failed-detail"
              >
                {loadError}
              </pre>
            </details>
          )}
        </NoticeItem>
      </div>
    </div>
  )
}
