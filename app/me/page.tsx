"use client"

/**
 * "Me" tab (Wave 2.4 → /me iOS-style refactor).
 *
 * iOS Settings layout:
 *   ┌─ Header (sticky)                                  ─┐
 *   │  我的                              [ConnectionBadge]│
 *   ├─ AccountCard  (live identity + 5h/7d usage)        ┤
 *   ├─ TodayStatsCard  (sessions · drafts · last backup) ┤
 *   ├─ QuickActionGrid (theme · lang · CU · scan)        ┤
 *   ├─ MeSection: 账户                                   ┤
 *   ├─ MeSection: 连接                                   ┤
 *   ├─ MeSection: 外观与体验                             ┤
 *   ├─ MeSection: 数据                                   ┤
 *   ├─ MeSection: 关于                                   ┤
 *   └─ SignOutButton (biometric-gated, clears both)      ┘
 *
 * All section links route to mobile sub-pages under `/me/<route>` —
 * desktop `/settings?section=…` deep-links no longer exist (mobile
 * redirected them back to `/`, leaving the rows as dead-ends).
 */

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import {
  BellIcon,
  BookmarkIcon,
  BookOpenIcon,
  CalendarClockIcon,
  ChartBarIcon,
  DatabaseIcon,
  HardDriveIcon,
  InfoIcon,
  KeyRoundIcon,
  LinkIcon,
  MessageSquareIcon,
  MonitorIcon,
  PaletteIcon,
  RefreshCwIcon,
  SaveIcon,
  ScanIcon,
  SlidersHorizontalIcon,
  SmartphoneIcon,
  TypeIcon,
} from "lucide-react"

import { AccountCard } from "@/components/mobile/me/account-card"
import { MeRow } from "@/components/mobile/me/me-row"
import { MeSection } from "@/components/mobile/me/me-section"
import { QuickActionGrid } from "@/components/mobile/me/quick-action-grid"
import { SignOutButton } from "@/components/mobile/me/sign-out-button"
import { TodayStatsCard } from "@/components/mobile/me/today-stats-card"
import { VersionRow } from "@/components/mobile/me/version-row"
import { ConnectionStateBadge } from "@/components/mobile/connection-state-badge"
import { useCompanionConfig } from "@/hooks/companion/use-companion-config"
import { usePlatform } from "@/hooks/use-platform"

export default function MePage() {
  const t = useTranslations("mobile.me")
  const platform = usePlatform()
  const router = useRouter()
  const [mounted, setMounted] = useState(false)
  const { paired, shortDeviceId } = useCompanionConfig()

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true)
  }, [])

  useEffect(() => {
    if (!mounted) return
    if (platform === "mobile") return
    router.replace("/settings")
  }, [mounted, platform, router])

  if (!mounted || platform !== "mobile") return null

  return (
    <main
      className="flex h-full min-h-0 flex-1 flex-col overflow-y-auto bg-background safe-area-pt"
      data-testid="me-page"
    >
      <header className="sticky top-0 z-10 flex items-center gap-2 border-b bg-background/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/75">
        <h1 className="flex-1 text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <ConnectionStateBadge />
      </header>

      <section className="flex flex-col gap-3 px-4 pt-3">
        <AccountCard />
        <TodayStatsCard />
        <QuickActionGrid />
      </section>

      <div className="flex flex-col gap-4 px-4 pb-8 pt-5">
        <MeSection title={t("sectionAccount")} testid="me-section-account">
          <MeRow
            icon={KeyRoundIcon}
            label={t("subscriptionRow")}
            href="/me/subscription"
            testid="me-row-subscription"
          />
          <MeRow icon={RefreshCwIcon} label={t("syncRow")} href="/me/sync" testid="me-row-sync" />
          <MeRow
            icon={SmartphoneIcon}
            label={t("devicesRow")}
            value={paired && shortDeviceId ? shortDeviceId : undefined}
            href="/me/devices"
            testid="me-row-devices"
          />
          {!paired ? (
            <MeRow
              icon={ScanIcon}
              label={t("actionPair")}
              href="/pair"
              destructive={false}
              testid="me-row-pair"
            />
          ) : null}
        </MeSection>

        <MeSection title={t("sectionAppearance")} testid="me-section-appearance">
          <MeRow
            icon={PaletteIcon}
            label={t("appearanceLink")}
            href="/me/appearance"
            testid="me-row-appearance"
          />
          <MeRow
            icon={BellIcon}
            label={t("notificationsRow")}
            href="/me/notifications"
            testid="me-row-notifications"
          />
          <MeRow
            icon={TypeIcon}
            label={t("preferencesRow")}
            href="/me/preferences"
            testid="me-row-preferences"
          />
          <MeRow
            icon={BookmarkIcon}
            label={t("presetsRow")}
            href="/me/presets"
            testid="me-row-presets"
          />
        </MeSection>

        <MeSection title={t("sectionConnection")} testid="me-section-connection">
          <MeRow
            icon={LinkIcon}
            label={t("connectorsRow")}
            href="/me/connectors"
            testid="me-row-connectors"
          />
          <MeRow
            icon={SlidersHorizontalIcon}
            label={t("ocrRow")}
            href="/me/ocr"
            testid="me-row-ocr"
          />
          <MeRow
            icon={MonitorIcon}
            label={t("computerUseRow")}
            href="/me/computer-use"
            testid="me-row-computer-use"
          />
        </MeSection>

        <MeSection title={t("sectionAutomation")} testid="me-section-automation">
          <MeRow
            icon={CalendarClockIcon}
            label={t("schedulerRow")}
            href="/me/scheduler"
            testid="me-row-scheduler"
          />
        </MeSection>

        <MeSection title={t("sectionData")} testid="me-section-data">
          <MeRow icon={SaveIcon} label={t("backupRow")} href="/me/backup" testid="me-row-backup" />
          <MeRow
            icon={DatabaseIcon}
            label={t("dexieMaintenance")}
            href="/me/maintenance"
            testid="me-row-maintenance"
          />
          <MeRow
            icon={HardDriveIcon}
            label={t("storageRow")}
            href="/me/storage"
            testid="me-row-storage"
          />
        </MeSection>

        <MeSection title={t("sectionAbout")} testid="me-section-about">
          <VersionRow />
          <MeRow icon={InfoIcon} label={t("aboutRow")} href="/me/about" testid="me-row-about" />
          <MeRow icon={BookOpenIcon} label={t("helpRow")} href="/me/help" testid="me-row-help" />
          <MeRow
            icon={MessageSquareIcon}
            label={t("feedbackRow")}
            href="/me/feedback"
            testid="me-row-feedback"
          />
          <MeRow
            icon={ChartBarIcon}
            label={t("deviceInfoRow")}
            href="/me/device-info"
            testid="me-row-device-info"
          />
        </MeSection>

        <SignOutButton className="mt-2" />
      </div>
    </main>
  )
}
