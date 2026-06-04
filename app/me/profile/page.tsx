"use client"

/**
 * Mobile Profile route — full-screen wrapper around the shared
 * `<ProfileSection />` component used in the desktop Settings sidebar
 * (`/settings?section=profile`). Same dual-mount pattern as
 * `/me/appearance`: the section reads/writes `AppSettings.profile` through
 * `useUserProfile()`, so both surfaces stay in lockstep.
 */

import { useTranslations } from "next-intl"

import { ProfileSection } from "@/components/settings/profile/profile-section"
import { SubPageShell } from "@/components/mobile/me/sub-page-shell"

export default function MobileProfilePage() {
  const t = useTranslations("mobile.me")

  return (
    <SubPageShell
      title={t("profileRow")}
      backAria={t("profileBackAria")}
      testid="mobile-profile-page"
    >
      <ProfileSection />
    </SubPageShell>
  )
}
