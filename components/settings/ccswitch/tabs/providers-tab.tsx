"use client"

// CCSwitch → Providers tab. Lists every provider in cc-switch.db with its
// kind/baseUrl/model and an "active in cognia-next" badge for whichever
// matches the current `apiKey + apiBaseUrl` pair. Row actions:
//   - "Use here"        → switch cognia-next's bundled SDK only
//   - "Use here & in…"  → opens the dialog with the per-agent multi-select
//
// CCSwitch remains the editor for these records — there is no add/edit/
// delete here. The user goes back to CCSwitch for those operations.

import { useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { ZapIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import {
  SettingsAlert,
  SettingsCard,
  SettingsEmptyState,
} from "@/components/settings/common/settings-section"

import { useCcswitchProviders, useCcswitchStatus } from "@/lib/ccswitch/hooks"
import { detectActive } from "@/lib/ccswitch/switch"
import type { ActiveProviderState, CcswitchAgentId, CcswitchProvider } from "@/types/ccswitch"
import { getSettings } from "@/lib/db/settings"
import { isTauri } from "@/lib/tauri"

import { ProviderSwitchDialog } from "../provider-switch-dialog"

export function CcswitchProvidersTab() {
  const t = useTranslations("ccswitch")
  const tabReady = isTauri()

  const [watchDb, setWatchDb] = useState(false)
  const [manualDataDir, setManualDataDir] = useState<string | undefined>(undefined)
  const [defaultPropagation, setDefaultPropagation] = useState<CcswitchAgentId[]>([])
  useEffect(() => {
    if (!tabReady) return
    void getSettings().then((s) => {
      setWatchDb(s.ccswitchSync?.watchDb ?? true)
      setManualDataDir(s.ccswitchSync?.manualDataDir)
      setDefaultPropagation(s.ccswitchSync?.defaultPropagation ?? [])
    })
  }, [tabReady])

  const { data: status } = useCcswitchStatus(tabReady, watchDb, manualDataDir)
  const {
    data: providers,
    loading,
    error,
    refresh,
  } = useCcswitchProviders(tabReady && status?.exists === true, watchDb, manualDataDir)

  const [active, setActive] = useState<ActiveProviderState | null>(null)
  const [dialogProvider, setDialogProvider] = useState<CcswitchProvider | null>(null)
  const [dialogPrefill, setDialogPrefill] = useState<CcswitchAgentId[]>([])

  useEffect(() => {
    if (!providers) return
    void detectActive(providers).then(setActive)
  }, [providers])

  const sorted = useMemo(() => {
    if (!providers) return []
    // Active provider floats to the top, then alpha by name.
    const activeId = active?.cognia
    return [...providers].sort((a, b) => {
      if (a.id === activeId) return -1
      if (b.id === activeId) return 1
      return a.name.localeCompare(b.name)
    })
  }, [providers, active?.cognia])

  if (!tabReady) {
    return (
      <SettingsAlert title={t("overview.webModeTitle")}>{t("overview.webModeBody")}</SettingsAlert>
    )
  }

  if (status && !status.exists) {
    return (
      <SettingsEmptyState
        title={t("overview.notFoundTitle")}
        description={t("overview.notFoundBody")}
      />
    )
  }

  if (loading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    )
  }

  if (error) {
    return (
      <SettingsAlert variant="destructive" title={t("providers.errorTitle")}>
        {error}
      </SettingsAlert>
    )
  }

  if (!sorted.length) {
    return (
      <SettingsEmptyState
        title={t("providers.emptyTitle")}
        description={t("providers.emptyBody")}
      />
    )
  }

  const onUseHere = async (p: CcswitchProvider) => {
    setDialogProvider(p)
    setDialogPrefill([])
  }

  const onUseHereAndIn = async (p: CcswitchProvider) => {
    setDialogProvider(p)
    setDialogPrefill(defaultPropagation)
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">{t("providers.headerHint")}</p>
        <Button variant="ghost" size="sm" onClick={refresh}>
          {t("providers.refresh")}
        </Button>
      </div>

      <div className="space-y-2">
        {sorted.map((p) => {
          const isActive = active?.cognia === p.id
          return (
            <SettingsCard
              key={p.id}
              variant={isActive ? "bordered" : "default"}
              icon={isActive ? <ZapIcon className="size-4 text-green-600" /> : null}
              title={p.name}
              description={p.baseUrl ?? t("providers.officialEndpoint")}
              badge={isActive ? t("providers.activeBadge") : undefined}
              badgeVariant={isActive ? "default" : "secondary"}
              headerAction={
                <div className="flex items-center gap-2">
                  {p.kind && (
                    <Badge variant="outline" className="text-[10px]">
                      {p.kind}
                    </Badge>
                  )}
                  <Button size="sm" variant="outline" onClick={() => onUseHere(p)}>
                    {t("providers.useHere")}
                  </Button>
                  <Button size="sm" onClick={() => onUseHereAndIn(p)}>
                    {t("providers.useHereAndIn")}
                  </Button>
                </div>
              }
            >
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3 text-xs text-muted-foreground">
                {p.model && (
                  <div>
                    <span className="text-foreground">{t("providers.model")}: </span>
                    <span className="font-mono">{p.model}</span>
                  </div>
                )}
                {p.notes && <div>{p.notes}</div>}
              </div>
            </SettingsCard>
          )
        })}
      </div>

      <ProviderSwitchDialog
        provider={dialogProvider}
        initialAgents={dialogPrefill}
        open={dialogProvider !== null}
        onOpenChange={(open) => {
          if (!open) setDialogProvider(null)
        }}
        onApplied={async () => {
          if (providers) {
            const next = await detectActive(providers)
            setActive(next)
          }
        }}
      />
    </div>
  )
}
