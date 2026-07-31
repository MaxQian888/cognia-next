"use client"

/**
 * Settings → Automation → Overview → platform-capabilities card.
 *
 * A pure readout of what the active desktop-automation back-end can do, one
 * badge per capability. Extracted from `automation-section` so the badge set
 * (notably the cross-platform accessibility-tree row that unlocks the macOS
 * Inspector) can be unit-tested without mounting the whole settings section.
 *
 * `caps === null` means the capability probe failed / hasn't resolved (e.g. the
 * back-end couldn't initialize); we surface that honestly instead of an
 * all-green grid.
 */

import { useTranslations } from "next-intl"
import { CameraIcon } from "lucide-react"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import type { Capabilities } from "@/lib/automation/types"

export function PlatformCapabilitiesCard({ caps }: { caps: Capabilities | null }) {
  const t = useTranslations("automation.overview")
  const yes = t("yes")
  const no = t("no")
  const planned = t("noPlanned")

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CameraIcon className="size-4" />
          {t("platformCapabilities")}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {caps ? (
          <div className="flex flex-wrap gap-2">
            <CapBadge label={t("capabilities.platform")} value={caps.platform} />
            <CapBadge label={t("capabilities.uia")} value={caps.hasUia ? yes : no} />
            <CapBadge label={t("capabilities.a11yTree")} value={caps.hasA11yTree ? yes : no} />
            <CapBadge
              label={t("capabilities.inputSimulation")}
              value={caps.hasInputSim ? yes : no}
            />
            <CapBadge label={t("capabilities.screenshot")} value={caps.hasScreenshot ? yes : no} />
            <CapBadge label={t("capabilities.events")} value={caps.hasEvents ? yes : planned} />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t("capabilityProbeFailed")}</p>
        )}
      </CardContent>
    </Card>
  )
}

function CapBadge({ label, value }: { label: string; value: string }) {
  return (
    <Badge variant="secondary" className="gap-1">
      <span className="text-muted-foreground">{label}</span>
      <span>{value}</span>
    </Badge>
  )
}
