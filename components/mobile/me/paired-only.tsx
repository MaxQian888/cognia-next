"use client"

/**
 * Gate for agent-class settings that only have a real backend when the phone
 * is paired to a desktop (ADR-0056, decision D2). The standalone (BYOK)
 * in-webview engine runs no tools / agent loop / permission modes, so these
 * panels would be dead UI there. When unpaired we render a short "connect a
 * desktop" placeholder instead of the children.
 *
 * Pairing state comes from `useCompanionConfig().paired` (a recoverable P-256 device identity),
 * which is the operational requirement: editing these settings means remote-
 * editing the desktop sidecar via the companion `app_settings_update` RPC.
 */

import type { ReactNode } from "react"
import { useTranslations } from "next-intl"
import { MonitorSmartphoneIcon } from "lucide-react"

import { MeSection } from "@/components/mobile/me/me-section"
import { useCompanionConfig } from "@/hooks/companion/use-companion-config"

export interface PairedOnlyProps {
  children: ReactNode
  /** Test id for the unpaired placeholder section. */
  testid?: string
}

export function PairedOnly({ children, testid }: PairedOnlyProps) {
  const t = useTranslations("mobile.pairedOnly")
  const { paired, loading } = useCompanionConfig()

  // Avoid flashing the placeholder before the JWT has hydrated.
  if (loading) return null

  if (!paired) {
    return (
      <MeSection
        title={t("title")}
        description={t("description")}
        testid={testid ?? "paired-only-placeholder"}
      >
        <div className="flex items-start gap-3 px-3 py-4 text-sm text-muted-foreground">
          <MonitorSmartphoneIcon className="mt-0.5 size-5 shrink-0" aria-hidden />
          <p>{t("hint")}</p>
        </div>
      </MeSection>
    )
  }

  return <>{children}</>
}
