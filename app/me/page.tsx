"use client"

/**
 * "Me" tab (Wave 2.4).
 *
 * Settings overview + pairing status + quick links to data/backup, app
 * security, and the full settings page. Designed for the mobile shell but
 * also viewable on desktop / web — the tab bar is the primary entry.
 */

import Link from "next/link"
import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import {
  ChevronRightIcon,
  CloudUploadIcon,
  DatabaseIcon,
  KeyRoundIcon,
  PaletteIcon,
  ShieldCheckIcon,
  SmartphoneIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { MobileBackupSection } from "@/components/mobile/backup/mobile-backup-section"
import { hydrateCompanionConfig } from "@/lib/tauri/transport-companion"
import type { CompanionConfig } from "@/lib/tauri/transport-companion"

interface SectionLinkProps {
  href: string
  label: string
  icon: typeof PaletteIcon
  testId?: string
}

function SectionLink({ href, label, icon: Icon, testId }: SectionLinkProps) {
  return (
    <Link
      href={href}
      data-testid={testId}
      className="flex items-center gap-3 rounded-md border border-border bg-card px-4 py-3 text-sm font-medium active:bg-muted/50"
    >
      <Icon className="size-5 text-muted-foreground" aria-hidden="true" />
      <span className="flex-1">{label}</span>
      <ChevronRightIcon className="size-4 text-muted-foreground" aria-hidden="true" />
    </Link>
  )
}

export default function MePage() {
  const t = useTranslations("mobile.me")
  const [config, setConfig] = useState<CompanionConfig | null>(null)

  useEffect(() => {
    let cancelled = false
    void hydrateCompanionConfig()
      .then((cfg) => {
        if (!cancelled) setConfig(cfg)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const paired = !!config

  return (
    <main className="flex min-h-[100dvh] flex-col bg-background safe-area-pt" data-testid="me-page">
      <header className="px-4 py-3">
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
      </header>

      {/* Pairing status card */}
      <section className="px-4">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              <SmartphoneIcon className="size-4" aria-hidden="true" />
              {t("pairing")}
            </CardTitle>
            <CardDescription className="text-xs">
              {paired
                ? t("pairingPaired", { deviceId: (config?.deviceId ?? "").slice(0, 8) })
                : t("pairingUnpaired")}
            </CardDescription>
          </CardHeader>
          {!paired ? (
            <CardContent>
              <Button asChild size="sm" data-testid="me-go-pair">
                <Link href="/pair">{t("actionPair")}</Link>
              </Button>
            </CardContent>
          ) : null}
        </Card>
      </section>

      {/* Sections */}
      <section className="mt-4 flex flex-col gap-3 px-4 pb-6">
        <h2 className="text-xs font-medium uppercase text-muted-foreground">
          {t("sectionAccount")}
        </h2>
        <SectionLink
          href="/settings?section=subscription"
          label={t("settingsLink")}
          icon={KeyRoundIcon}
          testId="me-settings"
        />

        <h2 className="mt-2 text-xs font-medium uppercase text-muted-foreground">
          {t("sectionData")}
        </h2>
        <MobileBackupSection />
        <SectionLink
          href="/settings?section=data&dataTab=maintenance"
          label="Dexie maintenance"
          icon={DatabaseIcon}
          testId="me-maintenance"
        />

        <h2 className="mt-2 text-xs font-medium uppercase text-muted-foreground">
          {t("sectionAppearance")}
        </h2>
        <SectionLink
          href="/settings?section=appearance"
          label="Appearance"
          icon={PaletteIcon}
          testId="me-appearance"
        />

        <h2 className="mt-2 text-xs font-medium uppercase text-muted-foreground">
          {t("sectionAdvanced")}
        </h2>
        <SectionLink
          href="/settings?section=connections"
          label={t("appSecurity")}
          icon={ShieldCheckIcon}
          testId="me-security"
        />
      </section>
    </main>
  )
}
