"use client"

import { useTranslations } from "next-intl"

import { MobileBackupSection } from "@/components/mobile/backup/mobile-backup-section"
import { SubPageShell } from "@/components/mobile/me/sub-page-shell"

export default function MobileBackupPage() {
  const t = useTranslations("mobile.me")
  return (
    <SubPageShell
      title={t("backupRow")}
      backAria={t("appearanceBackAria")}
      testid="mobile-backup-page"
      // MobileBackupSection embeds WebDavSyncCard from components/settings/,
      // which ships its own card chrome. Marking the body a settings panel is
      // what makes that section shed the frame on a phone.
      settingsPanel
    >
      <MobileBackupSection />
    </SubPageShell>
  )
}
