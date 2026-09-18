"use client"

/**
 * ProviderHostNotice — tells the user what this host can and cannot do with
 * the provider settings on screen (ADR-0056 / ADR-0097 host-mode contract).
 *
 * `companion`: on `cloud-companion` / `mobile-companion` the keys edited here
 * are device-local — provider configuration is `desktop-only` in the settings
 * sync taxonomy, so the paired host keeps its own. Without this the page
 * looked identical to the desktop one and implied the host would pick the
 * keys up.
 *
 * `mobile-local`: on the mobile shell "localhost" is the phone; a local
 * inference engine row is only useful pointed at another machine.
 *
 * Renders nothing on hosts where neither caveat applies. Each kind is
 * dismissible on its own; the dismissal lives in localStorage (device-local,
 * like the settings the notice describes) and does not expire.
 */

import { useState } from "react"
import { Cloud, Smartphone, X } from "lucide-react"
import { useTranslations } from "next-intl"

import { SettingsAlert } from "@/components/settings/common/settings-section"
import { Button } from "@/components/ui/button"
import { useHostProfile } from "@/hooks/use-host-profile"
import { hashSet, readDismiss, safeStorage, writeDismiss } from "@/lib/inbox/notice-dismiss"

export type ProviderHostNoticeKind = "companion" | "mobile-local"

export interface ProviderHostNoticeProps {
  kind: ProviderHostNoticeKind
  className?: string
}

export function ProviderHostNotice({ kind, className }: ProviderHostNoticeProps) {
  const t = useTranslations("providers")
  const profile = useHostProfile()
  // Per-kind key so dismissing the companion banner on a phone does not also
  // silence the mobile-local one (or vice versa).
  const storageKey = `settings.providerHostNotice.${kind}.dismiss`
  const [dismissed, setDismissed] = useState(
    () => readDismiss(storageKey, safeStorage("local"))?.hash === hashSet([kind])
  )

  if (kind === "companion") {
    if (profile !== "cloud-companion" && profile !== "mobile-companion") return null
  } else if (profile !== "mobile-companion") {
    return null
  }
  if (dismissed) return null

  const dismiss = (
    <Button
      variant="ghost"
      size="icon"
      // `action` renders inside the description row; absolute placement lifts
      // the button up to the alert's top-right corner, level with the title.
      className="absolute right-2 top-2 h-6 w-6 shrink-0"
      onClick={() => {
        writeDismiss(storageKey, hashSet([kind]), safeStorage("local"))
        setDismissed(true)
      }}
      aria-label={t("hostNotice.dismiss")}
      title={t("hostNotice.dismiss")}
    >
      <X className="h-3.5 w-3.5" />
    </Button>
  )

  if (kind === "companion") {
    return (
      <SettingsAlert
        icon={<Cloud className="h-4 w-4" />}
        title={t("hostNotice.companionTitle")}
        className={className}
        action={dismiss}
      >
        <span data-testid="provider-host-notice-companion">{t("hostNotice.companionBody")}</span>
      </SettingsAlert>
    )
  }

  return (
    <SettingsAlert
      icon={<Smartphone className="h-4 w-4" />}
      title={t("hostNotice.mobileLocalTitle")}
      className={className}
      action={dismiss}
    >
      <span data-testid="provider-host-notice-mobile-local">{t("hostNotice.mobileLocalBody")}</span>
    </SettingsAlert>
  )
}

export default ProviderHostNotice
