"use client"

/**
 * Mobile cloud-account route: which Cognia Cloud this phone signs in to.
 *
 * A phone has no pairing and no build-time server URL, so without this card
 * discovery finds nothing and the sign-in gate lets the person straight past.
 * The card stores the gateway address, and the gate (which already runs
 * through the in-app browser on Capacitor) does the sign-in itself.
 *
 * Reused rather than rebuilt, the same way `/me/appearance` embeds the desktop
 * appearance section.
 */

import { useTranslations } from "next-intl"

import { CloudDeploymentCard } from "@/components/settings/companion/cloud-deployment-card"
import { SubPageShell } from "@/components/mobile/me/sub-page-shell"

export default function MobileCloudAccountPage() {
  const t = useTranslations("mobile.me")

  return (
    <SubPageShell
      title={t("cloudAccountRow")}
      backAria={t("appearanceBackAria")}
      testid="mobile-cloud-account-page"
    >
      <CloudDeploymentCard />
    </SubPageShell>
  )
}
