"use client"

import { useTranslations } from "next-intl"
import { KeyRound } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import type { SecretStoreReadiness } from "@/lib/credentials/secret-store-readiness"

export interface SecretStoreLockedNoticeProps {
  readiness: SecretStoreReadiness
  unlocking: boolean
  failed: boolean
  onUnlock: () => void
  className?: string
}

/**
 * The cold-boot Retry for a locked encrypted secret store.
 *
 * Rendered by the recovery boot gate in both modes — as a card inside the
 * diagnostics shell and as a pinned notice above a normally booted app — so a
 * Keychain that was locked, denied or cancelled at startup always has a
 * visible way back, not only when a proxy credential happens to need it.
 * The Unlock click is the only renderer path allowed to show the OS keychain
 * dialog. Renders nothing unless the store is `locked`.
 */
export function SecretStoreLockedNotice({
  readiness,
  unlocking,
  failed,
  onUnlock,
  className,
}: SecretStoreLockedNoticeProps) {
  const t = useTranslations("safeMode.secretStore")
  if (readiness !== "locked") return null

  return (
    <section aria-label={t("region")} className={className}>
      <Alert>
        <KeyRound aria-hidden />
        <AlertTitle>{t("title")}</AlertTitle>
        <AlertDescription className="space-y-2">
          <p>{t("description")}</p>
          {failed ? (
            <p role="alert" className="text-destructive">
              {t("failed")}
            </p>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            disabled={unlocking}
            aria-busy={unlocking}
            onClick={onUnlock}
            className="mt-1"
          >
            {unlocking ? t("unlocking") : t("unlock")}
          </Button>
        </AlertDescription>
      </Alert>
    </section>
  )
}
