"use client"

/**
 * Mobile cloud-account route — signing in to the Logto tenant that fronts a
 * cloud or headless `cognia-server` (ADR-0059).
 *
 * The card was already host-neutral in everything but its own claim: `openUrl`
 * routes through the Capacitor in-app browser, the PKCE flow is plain fetch,
 * and the session store falls back to an encrypted IndexedDB vault. It just had
 * no route on the phone and told the user cloud sign-in was desktop-only. So a
 * phone connecting directly to a multi-user cloud deployment — the exact setup
 * Logto exists for — had no way to authenticate.
 *
 * Reused rather than rebuilt, the same way `/me/appearance` embeds the desktop
 * appearance section.
 */

import { useTranslations } from "next-intl"

import { LogtoLoginCard } from "@/components/settings/companion/logto-login-card"
import { SubPageShell } from "@/components/mobile/me/sub-page-shell"

export default function MobileCloudAccountPage() {
  const t = useTranslations("mobile.me")

  return (
    <SubPageShell
      title={t("cloudAccountRow")}
      backAria={t("appearanceBackAria")}
      testid="mobile-cloud-account-page"
    >
      <LogtoLoginCard />
    </SubPageShell>
  )
}
