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
    >
      <MobileBackupSection />
    </SubPageShell>
  )
}
