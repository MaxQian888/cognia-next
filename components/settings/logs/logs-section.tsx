"use client"

/**
 * Settings → Observability → Logs.
 *
 * Was two link cards stacked above a 2 300-line component whose five tabs
 * (`Levels / Transports / PostHog / Advanced / Retention`) appeared with no
 * visual relationship to anything around them — a tab strip floating inside a
 * page that already had a sidebar. It is now the same master/detail shell the
 * Gateway, External Bridge and Memory sections use: a grouped rail on the left,
 * one panel on the right, and a save bar that only appears when there is
 * something to save.
 *
 * State lives in `useLogSettingsDraft` and every panel is presentational, so
 * the transport health poll runs once here rather than once per panel.
 */

import { useCallback, useMemo, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { useTranslations } from "next-intl"
import { RotateCcwIcon, ScrollTextIcon } from "lucide-react"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { PanelTransition } from "@/components/settings/common/panel-transition"
import { SettingsMasterDetail } from "@/components/settings/common/settings-master-detail"
import { UnsavedBar } from "@/components/settings/common/unsaved-bar"
import { useTransportHealth } from "@/hooks/logging"
import {
  useLogSettingsDraft,
  TRANSPORT_KEYS,
  type TransportKey,
} from "@/hooks/logging/use-log-settings-draft"

import { LogsNav } from "./components/logs-nav"
import { LOGS_NAV_GROUPS, LOGS_PANEL_PARAM, resolveLogsPanel, type LogsPanelId } from "./nav-config"
import { LogsFiltersPanel } from "./panels/filters-panel"
import { LogsLevelsPanel } from "./panels/levels-panel"
import { LogsOverviewPanel } from "./panels/overview-panel"
import { LogsRetentionPanel } from "./panels/retention-panel"
import { LogsTelemetryPanel } from "./panels/telemetry-panel"
import { LogsTransportsPanel } from "./panels/transports-panel"

export interface LogsSectionProps {
  /** Closes the host Settings dialog/sheet when a panel navigates to `/logs`. */
  onClose?: () => void
}

export function LogsSection({ onClose }: LogsSectionProps) {
  const t = useTranslations("logging")
  const router = useRouter()
  const searchParams = useSearchParams()

  const draft = useLogSettingsDraft()
  const { nativeLogging, healthByTransport } = useTransportHealth({
    autoRefresh: true,
    refreshInterval: 3000,
  })

  const [resetOpen, setResetOpen] = useState(false)
  // Enabled transports open their configuration by default: a switch that is
  // on but blank is the state worth showing.
  const [expanded, setExpanded] = useState<Record<TransportKey, boolean>>(
    () =>
      Object.fromEntries(
        TRANSPORT_KEYS.map((key) => [key, Boolean(draft.transports[key])])
      ) as Record<TransportKey, boolean>
  )

  const activePanel = resolveLogsPanel(searchParams.get(LOGS_PANEL_PARAM))

  const onSelect = useCallback(
    (id: LogsPanelId) => {
      const next = new URLSearchParams(searchParams.toString())
      next.set(LOGS_PANEL_PARAM, id)
      router.replace(`?${next.toString()}`, { scroll: false })
    },
    [router, searchParams]
  )

  const setTransportExpanded = useCallback((transport: TransportKey, open: boolean) => {
    setExpanded((previous) => ({ ...previous, [transport]: open }))
  }, [])

  const badges = useMemo(() => {
    const enabled = TRANSPORT_KEYS.filter((key) => Boolean(draft.transports[key])).length
    return {
      transports: {
        text: `${enabled}/${TRANSPORT_KEYS.length}`,
        variant: "secondary" as const,
        ariaLabel: t("settings.nav.badgeTransportsAria", {
          enabled,
          total: TRANSPORT_KEYS.length,
        }),
      },
    }
  }, [draft.transports, t])

  const renderNav = (idPrefix: string) => (
    <LogsNav
      groups={LOGS_NAV_GROUPS}
      activeId={activePanel}
      onSelect={onSelect}
      badges={badges}
      idPrefix={idPrefix}
    />
  )

  const panel = (() => {
    switch (activePanel) {
      case "overview":
        return (
          <LogsOverviewPanel
            nativeLogging={nativeLogging}
            healthByTransport={healthByTransport}
            onNavigateAway={onClose}
          />
        )
      case "levels":
        return <LogsLevelsPanel draft={draft} />
      case "filters":
        return <LogsFiltersPanel draft={draft} />
      case "transports":
        return (
          <LogsTransportsPanel
            draft={draft}
            healthByTransport={healthByTransport}
            expanded={expanded}
            onExpandedChange={setTransportExpanded}
          />
        )
      case "telemetry":
        return <LogsTelemetryPanel draft={draft} />
      case "retention":
        return <LogsRetentionPanel draft={draft} />
    }
  })()

  return (
    <div className="flex h-full min-h-0 flex-col gap-4" data-testid="logs-section">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3 border-b border-border/60 pb-4">
        <div className="flex min-w-0 items-start gap-2.5">
          <ScrollTextIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 space-y-0.5">
            <h2 className="text-base font-semibold tracking-tight">{t("settingsTitle")}</h2>
            <p className="text-xs text-pretty text-muted-foreground">{t("settingsDescription")}</p>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={() => setResetOpen(true)}
          data-testid="logs-restore-defaults"
        >
          <RotateCcwIcon className="mr-1.5 size-3.5" />
          {t("settings.restoreDefaults.button")}
        </Button>
      </div>

      <SettingsMasterDetail
        nav={(slot) => (slot === "rail" ? renderNav("logs") : renderNav("logs-sheet"))}
        navTitle={t("settings.nav.title")}
        mobileTriggerLabel={t("settings.nav.mobileTrigger")}
        activeKey={activePanel}
        activeLabel={t(`settings.nav.items.${activePanel}.label`)}
        navWidth={260}
        triggerTestId="logs-mobile-nav-trigger"
      >
        {/* `@container/settings-stack` is declared by `SettingsStack` inside
            each panel, so every multi-column row measures this pane rather
            than the window. */}
        <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border">
          <section
            aria-labelledby={`logs-panel-${activePanel}`}
            className="min-h-0 flex-1 overflow-y-auto p-4"
            data-testid="logs-panel-body"
          >
            <h3 id={`logs-panel-${activePanel}`} className="mb-3 text-sm font-semibold">
              {t(`settings.nav.items.${activePanel}.label`)}
            </h3>
            <PanelTransition activeKey={activePanel}>{panel}</PanelTransition>

            {/* Sticky, not absolute: on the desktop pane it pins to the pane's
                bottom edge, and on the `/me/logs` route — where the pane grows
                with its content and the page scrolls — it pins to the viewport
                instead of hiding at the very end of a long panel. */}
            <div className="sticky bottom-0 z-10 -mx-4 mt-4 flex items-center justify-end gap-2 px-4">
              {draft.saveError ? (
                <span className="text-xs text-destructive" role="alert">
                  {t("settings.saveError")}
                </span>
              ) : null}
              <UnsavedBar
                status={draft.status}
                count={draft.changedCount}
                onSave={() => void draft.save()}
                onDiscard={draft.discard}
              />
            </div>
          </section>
        </div>
      </SettingsMasterDetail>

      <AlertDialog open={resetOpen} onOpenChange={setResetOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("settings.restoreDefaults.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings.restoreDefaults.description")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("settings.restoreDefaults.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              data-testid="logs-restore-defaults-confirm"
              onClick={(event) => {
                event.preventDefault()
                draft.reset()
                setExpanded(
                  Object.fromEntries(TRANSPORT_KEYS.map((key) => [key, false])) as Record<
                    TransportKey,
                    boolean
                  >
                )
                setResetOpen(false)
              }}
            >
              {t("settings.restoreDefaults.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

export default LogsSection
