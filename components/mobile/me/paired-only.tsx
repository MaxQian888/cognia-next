"use client"

/**
 * Gate for agent-class settings that only have a real backend when the phone
 * is paired to a desktop (ADR-0056, decision D2). The standalone (BYOK)
 * in-webview engine runs no tools / agent loop / permission modes, so these
 * panels would be dead UI there. When unpaired we render a centred
 * "connect a desktop" empty state instead of the children.
 *
 * Pairing state comes from `useCompanionConfig().paired` (a recoverable P-256 device identity),
 * which is the operational requirement: editing these settings means remote-
 * editing the desktop sidecar via the companion `app_settings_update` RPC.
 *
 * The placeholder is an `Empty` rather than a `MeSection`. Thirteen `/me`
 * pages route through here, and every one of them used to open on a short
 * bordered box glued to the top of an otherwise blank 800px screen, telling
 * the reader to go find the pairing entry themselves. It is the whole page
 * when it shows, so it gets the whole page: no card, and the sentence that
 * named the Account section is now the button that goes there.
 */

import type { ReactNode } from "react"
import Link from "next/link"
import { useTranslations } from "next-intl"
import { MonitorSmartphoneIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
} from "@/components/ui/empty"
import { useCompanionConfig } from "@/hooks/companion/use-companion-config"

export interface PairedOnlyProps {
  children: ReactNode
  /** Test id for the unpaired placeholder. */
  testid?: string
}

export function PairedOnly({ children, testid }: PairedOnlyProps) {
  const t = useTranslations("mobile.pairedOnly")
  const { paired, loading } = useCompanionConfig()

  // Avoid flashing the placeholder before the JWT has hydrated.
  if (loading) return null

  if (!paired) {
    return (
      <Empty
        className="min-h-[55vh] justify-center gap-5 px-2 py-10"
        data-testid={testid ?? "paired-only-placeholder"}
      >
        <EmptyHeader>
          <EmptyMedia variant="icon" className="size-12 rounded-2xl">
            <MonitorSmartphoneIcon className="size-6" aria-hidden />
          </EmptyMedia>
          <h2 className="text-lg font-medium tracking-tight">{t("title")}</h2>
          <EmptyDescription>{t("hint")}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button asChild size="sm" data-testid="paired-only-action">
            <Link href="/pair">{t("action")}</Link>
          </Button>
        </EmptyContent>
      </Empty>
    )
  }

  return <>{children}</>
}
