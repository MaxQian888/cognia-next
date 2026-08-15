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
 * Renders nothing on hosts where neither caveat applies.
 */

import { Cloud, Smartphone } from "lucide-react"
import { useTranslations } from "next-intl"

import { SettingsAlert } from "@/components/settings/common/settings-section"
import { useHostProfile } from "@/hooks/use-host-profile"

export type ProviderHostNoticeKind = "companion" | "mobile-local"

export interface ProviderHostNoticeProps {
  kind: ProviderHostNoticeKind
  className?: string
}

export function ProviderHostNotice({ kind, className }: ProviderHostNoticeProps) {
  const t = useTranslations("providers")
  const profile = useHostProfile()

  if (kind === "companion") {
    if (profile !== "cloud-companion" && profile !== "mobile-companion") return null
    return (
      <SettingsAlert
        icon={<Cloud className="h-4 w-4" />}
        title={t("hostNotice.companionTitle")}
        className={className}
      >
        <span data-testid="provider-host-notice-companion">{t("hostNotice.companionBody")}</span>
      </SettingsAlert>
    )
  }

  if (profile !== "mobile-companion") return null
  return (
    <SettingsAlert
      icon={<Smartphone className="h-4 w-4" />}
      title={t("hostNotice.mobileLocalTitle")}
      className={className}
    >
      <span data-testid="provider-host-notice-mobile-local">{t("hostNotice.mobileLocalBody")}</span>
    </SettingsAlert>
  )
}

export default ProviderHostNotice
