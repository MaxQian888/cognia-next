"use client"

import { useCallback, useMemo, useState } from "react"
import Link from "next/link"
import { useTranslations } from "next-intl"
import {
  ActivityIcon,
  AlertTriangleIcon,
  CheckCircle2Icon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleDotIcon,
  HeartPulseIcon,
  ListRestartIcon,
  Loader2Icon,
  ReceiptTextIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  ScrollTextIcon,
  Settings2Icon,
  ShieldCheckIcon,
  Trash2Icon,
} from "lucide-react"

import { FeaturePageHeader } from "@/components/feature-shell/feature-page-header"
import { LogPanel } from "@/components/logging/log-panel"
import { Badge } from "@/components/ui/badge"
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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Textarea } from "@/components/ui/textarea"
import { useDiagnosticIncidents } from "@/hooks/logging/use-diagnostic-incidents"
import type { DiagnosticIncidentSummary } from "@/hooks/logging/use-diagnostic-incidents"
import { useEdgeResize, useIsNarrow } from "@/hooks/ui"
import { cn } from "@/lib/utils"
import {
  useLogWorkspaceStore,
  type IncidentStateFilter,
  type LogWorkspaceDensity,
  type LogWorkspaceSource,
  type LogWorkspaceView,
} from "@/stores/logging/log-workspace-store"

const NAVIGATION: Array<{
  id: LogWorkspaceView
  icon: typeof HeartPulseIcon
}> = [
  { id: "health", icon: HeartPulseIcon },
  { id: "logs", icon: ScrollTextIcon },
  { id: "incidents", icon: AlertTriangleIcon },
  { id: "receipts", icon: ReceiptTextIcon },
  { id: "recovery", icon: ListRestartIcon },
  { id: "advanced", icon: Settings2Icon },
]

const INCIDENT_STATES: IncidentStateFilter[] = [
  "all",
  "detected",
  "awaitingConsent",
  "queued",
  "uploading",
  "processing",
  "accepted",
  "rejected",
  "cancelled",
  "deleted",
]

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function displayPreview(preview: unknown): string {
  if (typeof preview === "string") return preview
  if (preview === null || preview === undefined) return ""
  return JSON.stringify(preview, null, 2)
}

export function DiagnosticsWorkspace() {
  const t = useTranslations("logging.workspace")
  const activeView = useLogWorkspaceStore((state) => state.activeView)
  const setActiveView = useLogWorkspaceStore((state) => state.setActiveView)
  const density = useLogWorkspaceStore((state) => state.density)
  const setDensity = useLogWorkspaceStore((state) => state.setDensity)
  const navigationWidth = useLogWorkspaceStore((state) => state.navigationWidth)
  const setNavigationWidth = useLogWorkspaceStore((state) => state.setNavigationWidth)
  const navigationCollapsed = useLogWorkspaceStore((state) => state.navigationCollapsed)
  const setNavigationCollapsed = useLogWorkspaceStore((state) => state.setNavigationCollapsed)
  const detailWidth = useLogWorkspaceStore((state) => state.detailWidth)
  const setDetailWidth = useLogWorkspaceStore((state) => state.setDetailWidth)
  const activeSource = useLogWorkspaceStore((state) => state.activeSource)
  const setActiveSource = useLogWorkspaceStore((state) => state.setActiveSource)
  const incidentStateFilter = useLogWorkspaceStore((state) => state.incidentStateFilter)
  const setIncidentStateFilter = useLogWorkspaceStore((state) => state.setIncidentStateFilter)
  const resetWorkspace = useLogWorkspaceStore((state) => state.resetWorkspace)
  const incidents = useDiagnosticIncidents()
  const narrow = useIsNarrow()
  const [selectedID, setSelectedID] = useState<string | null>(null)
  const [preview, setPreview] = useState<unknown>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<DiagnosticIncidentSummary | null>(null)

  const navigationResize = useEdgeResize({
    width: navigationWidth,
    min: 184,
    max: 360,
    onChange: setNavigationWidth,
    onReset: () => setNavigationWidth(248),
  })
  const detailResize = useEdgeResize({
    width: detailWidth,
    min: 280,
    max: 640,
    edge: "left",
    onChange: setDetailWidth,
    onReset: () => setDetailWidth(384),
  })

  const filteredIncidents = useMemo(
    () =>
      incidents.incidents.filter(
        (incident) =>
          (activeSource === "all" || incident.runtime === activeSource) &&
          (incidentStateFilter === "all" || incident.state === incidentStateFilter)
      ),
    [activeSource, incidentStateFilter, incidents.incidents]
  )
  const receiptIncidents = useMemo(
    () => filteredIncidents.filter((incident) => Boolean(incident.receiptCode)),
    [filteredIncidents]
  )
  const selectedIncident = useMemo(
    () =>
      (selectedID ? filteredIncidents.find((incident) => incident.id === selectedID) : undefined) ??
      filteredIncidents[0] ??
      null,
    [filteredIncidents, selectedID]
  )

  const selectIncident = useCallback(
    async (incident: DiagnosticIncidentSummary) => {
      setSelectedID(incident.id)
      setPreviewLoading(true)
      try {
        setPreview(await incidents.read(incident))
      } finally {
        setPreviewLoading(false)
      }
    },
    [incidents]
  )

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return
    await incidents.remove(deleteTarget)
    if (selectedID === deleteTarget.id) {
      setSelectedID(null)
      setPreview(null)
    }
    setDeleteTarget(null)
  }, [deleteTarget, incidents, selectedID])

  const openDetail = selectedID !== null && selectedIncident !== null
  const list = activeView === "receipts" ? receiptIncidents : filteredIncidents

  return (
    <div
      className="flex h-full min-h-0 flex-1 flex-col"
      data-testid="diagnostics-workspace"
      data-density={density}
    >
      <FeaturePageHeader
        testId="logs-page-header"
        icon={<ScrollTextIcon />}
        title={t("title")}
        breadcrumb={
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbLink asChild>
                  <Link href="/">{t("breadcrumbHome")}</Link>
                </BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbPage>{t("title")}</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        }
        status={
          <Badge variant="secondary" className="font-mono text-xs tabular-nums">
            {t("incidentCount", { count: incidents.incidents.length })}
          </Badge>
        }
        controls={
          <Select
            value={density}
            onValueChange={(value) => setDensity(value as LogWorkspaceDensity)}
          >
            <SelectTrigger className="h-8 w-[140px]" aria-label={t("density.label")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="compact">{t("density.compact")}</SelectItem>
              <SelectItem value="comfortable">{t("density.comfortable")}</SelectItem>
              <SelectItem value="spacious">{t("density.spacious")}</SelectItem>
            </SelectContent>
          </Select>
        }
        actions={
          <Button variant="outline" size="sm" className="h-8" onClick={resetWorkspace}>
            <RotateCcwIcon className="size-4" />
            <span className="hidden sm:inline">{t("reset")}</span>
          </Button>
        }
      />

      <MobileNavigation activeView={activeView} onSelect={setActiveView} />

      <div className="flex min-h-0 flex-1 overflow-hidden border-t">
        <aside
          className={cn(
            "relative hidden shrink-0 border-r bg-muted/20 md:flex md:flex-col",
            navigationCollapsed && "w-14"
          )}
          style={navigationCollapsed ? undefined : { width: navigationWidth }}
          data-testid="workspace-navigation"
        >
          <WorkspaceNavigation
            activeView={activeView}
            collapsed={navigationCollapsed}
            onSelect={setActiveView}
          />
          <Button
            variant="ghost"
            size="icon-sm"
            className="m-2 mt-auto self-end"
            onClick={() => setNavigationCollapsed(!navigationCollapsed)}
            aria-label={navigationCollapsed ? t("navigation.expand") : t("navigation.collapse")}
          >
            {navigationCollapsed ? (
              <ChevronRightIcon className="size-4" />
            ) : (
              <ChevronLeftIcon className="size-4" />
            )}
          </Button>
          {!navigationCollapsed && (
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label={t("navigation.resize")}
              tabIndex={0}
              className={cn(
                "absolute inset-y-0 -right-1 z-10 hidden w-2 cursor-col-resize touch-none xl:block",
                navigationResize.dragging && "bg-primary/10"
              )}
              onPointerDown={navigationResize.onPointerDown}
              onPointerMove={navigationResize.onPointerMove}
              onPointerUp={navigationResize.onPointerUp}
              onKeyDown={navigationResize.onKeyDown}
              onDoubleClick={navigationResize.onDoubleClick}
            />
          )}
        </aside>

        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {activeView === "logs" ? (
            <LogPanel
              showStats
              showTimeline
              includeAgentTrace={false}
              defaultAutoRefresh={false}
              refreshInterval={2000}
            />
          ) : activeView === "health" ? (
            <HealthView incidentCount={incidents.incidents.length} loading={incidents.loading} />
          ) : activeView === "recovery" ? (
            <RecoveryView />
          ) : activeView === "advanced" ? (
            <AdvancedView />
          ) : (
            <IncidentWorkspace
              incidents={list}
              loading={incidents.loading}
              error={incidents.error}
              selected={selectedIncident}
              preview={preview}
              previewLoading={previewLoading}
              activeSource={activeSource}
              incidentStateFilter={incidentStateFilter}
              onSourceChange={setActiveSource}
              onStateChange={setIncidentStateFilter}
              onRefresh={() => void incidents.refresh()}
              onSelect={(incident) => void selectIncident(incident)}
              onDelete={setDeleteTarget}
              detailWidth={detailWidth}
              detailResize={detailResize}
              receiptsOnly={activeView === "receipts"}
            />
          )}
        </main>
      </div>

      <Sheet
        open={openDetail && (activeView === "incidents" || activeView === "receipts")}
        onOpenChange={(open) => {
          if (!open) setSelectedID(null)
        }}
      >
        <SheetContent
          side={narrow ? "bottom" : "right"}
          className={cn(
            "p-0 xl:hidden",
            narrow ? "h-dvh max-h-dvh" : "w-[min(92vw,560px)] sm:max-w-none"
          )}
          data-testid="incident-detail-drawer"
        >
          <SheetHeader className="sr-only">
            <SheetTitle>{t("detail.title")}</SheetTitle>
            <SheetDescription>{t("detail.description")}</SheetDescription>
          </SheetHeader>
          {selectedIncident && (
            <IncidentDetail
              key={selectedIncident.id}
              incident={selectedIncident}
              preview={preview}
              previewLoading={previewLoading}
              onDelete={() => setDeleteTarget(selectedIncident)}
            />
          )}
        </SheetContent>
      </Sheet>

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("delete.title")}</AlertDialogTitle>
            <AlertDialogDescription>{t("delete.description")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("delete.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmDelete()}>
              {t("delete.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function MobileNavigation({
  activeView,
  onSelect,
}: {
  activeView: LogWorkspaceView
  onSelect: (view: LogWorkspaceView) => void
}) {
  const t = useTranslations("logging.workspace")
  return (
    <div
      className="flex gap-1 overflow-x-auto border-t px-2 py-2 md:hidden"
      aria-label={t("navigation.label")}
    >
      {NAVIGATION.map(({ id, icon: Icon }) => (
        <Button
          key={id}
          variant={activeView === id ? "secondary" : "ghost"}
          size="sm"
          className="shrink-0"
          onClick={() => onSelect(id)}
        >
          <Icon className="size-4" />
          {t(`views.${id}`)}
        </Button>
      ))}
    </div>
  )
}

function WorkspaceNavigation({
  activeView,
  collapsed,
  onSelect,
}: {
  activeView: LogWorkspaceView
  collapsed: boolean
  onSelect: (view: LogWorkspaceView) => void
}) {
  const t = useTranslations("logging.workspace")
  return (
    <nav className="space-y-1 p-2" aria-label={t("navigation.label")}>
      {NAVIGATION.map(({ id, icon: Icon }) => (
        <Button
          key={id}
          variant={activeView === id ? "secondary" : "ghost"}
          className={cn("w-full", collapsed ? "justify-center px-0" : "justify-start")}
          onClick={() => onSelect(id)}
          aria-label={collapsed ? t(`views.${id}`) : undefined}
        >
          <Icon className="size-4 shrink-0" />
          {!collapsed && <span>{t(`views.${id}`)}</span>}
        </Button>
      ))}
    </nav>
  )
}

function HealthView({ incidentCount, loading }: { incidentCount: number; loading: boolean }) {
  const t = useTranslations("logging.workspace")
  const cards = [
    { id: "capture", icon: ActivityIcon, status: "ready" },
    { id: "privacy", icon: ShieldCheckIcon, status: "protected" },
    { id: "retention", icon: ScrollTextIcon, status: "local" },
    { id: "submission", icon: CheckCircle2Icon, status: "consent" },
  ] as const
  return (
    <ScrollArea className="flex-1">
      <div className="mx-auto w-full max-w-6xl space-y-6 p-4 md:p-6">
        <div>
          <h2 className="text-lg font-semibold">{t("health.title")}</h2>
          <p className="text-sm text-muted-foreground">{t("health.description")}</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {cards.map(({ id, icon: Icon, status }) => (
            <Card key={id}>
              <CardHeader className="space-y-3 pb-3">
                <div className="flex items-center justify-between">
                  <Icon className="size-5 text-primary" />
                  <Badge variant="outline">{t(`health.status.${status}`)}</Badge>
                </div>
                <CardTitle className="text-base">{t(`health.cards.${id}.title`)}</CardTitle>
                <CardDescription>{t(`health.cards.${id}.description`)}</CardDescription>
              </CardHeader>
            </Card>
          ))}
        </div>
        <Card>
          <CardHeader>
            <CardTitle>{t("health.localIncidents")}</CardTitle>
            <CardDescription>{t("health.localIncidentsDescription")}</CardDescription>
          </CardHeader>
          <CardContent className="flex items-center gap-3">
            {loading ? (
              <Loader2Icon className="size-5 animate-spin" />
            ) : (
              <CircleDotIcon className="size-5" />
            )}
            <span className="text-2xl font-semibold tabular-nums">{incidentCount}</span>
          </CardContent>
        </Card>
      </div>
    </ScrollArea>
  )
}

function RecoveryView() {
  const t = useTranslations("logging.workspace")
  const checkpoints = ["account", "data", "plugins", "sidecars", "automation"] as const
  return (
    <ScrollArea className="flex-1">
      <div className="mx-auto w-full max-w-4xl space-y-5 p-4 md:p-6">
        <div>
          <h2 className="text-lg font-semibold">{t("recovery.title")}</h2>
          <p className="text-sm text-muted-foreground">{t("recovery.description")}</p>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>{t("recovery.normalTitle")}</CardTitle>
            <CardDescription>{t("recovery.normalDescription")}</CardDescription>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{t("recovery.checkpointsTitle")}</CardTitle>
            <CardDescription>{t("recovery.checkpointsDescription")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {checkpoints.map((checkpoint, index) => (
              <div key={checkpoint} className="flex items-center gap-3 rounded-lg border p-3">
                <Badge variant="secondary" className="size-6 justify-center rounded-full p-0">
                  {index + 1}
                </Badge>
                <div>
                  <div className="text-sm font-medium">
                    {t(`recovery.checkpoints.${checkpoint}.title`)}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {t(`recovery.checkpoints.${checkpoint}.description`)}
                  </div>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </ScrollArea>
  )
}

function AdvancedView() {
  const t = useTranslations("logging.workspace")
  return (
    <ScrollArea className="flex-1">
      <div className="mx-auto grid w-full max-w-5xl gap-4 p-4 md:grid-cols-2 md:p-6">
        {(["capabilities", "queues", "symbols", "schema"] as const).map((section) => (
          <Card key={section}>
            <CardHeader>
              <CardTitle>{t(`advanced.${section}.title`)}</CardTitle>
              <CardDescription>{t(`advanced.${section}.description`)}</CardDescription>
            </CardHeader>
            <CardContent>
              <Badge variant="outline">{t(`advanced.${section}.status`)}</Badge>
            </CardContent>
          </Card>
        ))}
      </div>
    </ScrollArea>
  )
}

function IncidentWorkspace({
  incidents,
  loading,
  error,
  selected,
  preview,
  previewLoading,
  activeSource,
  incidentStateFilter,
  onSourceChange,
  onStateChange,
  onRefresh,
  onSelect,
  onDelete,
  detailWidth,
  detailResize,
  receiptsOnly,
}: {
  incidents: DiagnosticIncidentSummary[]
  loading: boolean
  error: Error | null
  selected: DiagnosticIncidentSummary | null
  preview: unknown
  previewLoading: boolean
  activeSource: LogWorkspaceSource
  incidentStateFilter: IncidentStateFilter
  onSourceChange: (source: LogWorkspaceSource) => void
  onStateChange: (state: IncidentStateFilter) => void
  onRefresh: () => void
  onSelect: (incident: DiagnosticIncidentSummary) => void
  onDelete: (incident: DiagnosticIncidentSummary) => void
  detailWidth: number
  detailResize: ReturnType<typeof useEdgeResize>
  receiptsOnly: boolean
}) {
  const t = useTranslations("logging.workspace")
  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <section className="flex min-w-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-2 border-b p-3">
          <Select
            value={activeSource}
            onValueChange={(value) => onSourceChange(value as LogWorkspaceSource)}
          >
            <SelectTrigger className="h-8 w-[150px]" aria-label={t("filters.sourceLabel")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("filters.sources.all")}</SelectItem>
              <SelectItem value="desktop">{t("filters.sources.desktop")}</SelectItem>
              <SelectItem value="mobile">{t("filters.sources.mobile")}</SelectItem>
            </SelectContent>
          </Select>
          {!receiptsOnly && (
            <Select
              value={incidentStateFilter}
              onValueChange={(value) => onStateChange(value as IncidentStateFilter)}
            >
              <SelectTrigger className="h-8 w-[170px]" aria-label={t("filters.stateLabel")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {INCIDENT_STATES.map((state) => (
                  <SelectItem key={state} value={state}>
                    {t(`states.${state}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Button
            variant="outline"
            size="sm"
            className="ml-auto h-8"
            onClick={onRefresh}
            disabled={loading}
          >
            <RefreshCwIcon className={cn("size-4", loading && "animate-spin")} />
            {t("refresh")}
          </Button>
        </div>
        <ScrollArea className="flex-1">
          <div className="space-y-2 p-3" data-testid="incident-list">
            {error ? (
              <Card className="border-destructive/40">
                <CardContent className="p-4 text-sm text-destructive">
                  {t("incidents.error")}
                </CardContent>
              </Card>
            ) : loading && incidents.length === 0 ? (
              <div className="flex items-center justify-center gap-2 p-10 text-sm text-muted-foreground">
                <Loader2Icon className="size-4 animate-spin" />
                {t("incidents.loading")}
              </div>
            ) : incidents.length === 0 ? (
              <Card>
                <CardContent className="p-8 text-center">
                  <div className="font-medium">
                    {t(receiptsOnly ? "receipts.emptyTitle" : "incidents.emptyTitle")}
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {t(receiptsOnly ? "receipts.emptyDescription" : "incidents.emptyDescription")}
                  </p>
                </CardContent>
              </Card>
            ) : (
              incidents.map((incident) => (
                <button
                  type="button"
                  key={`${incident.runtime}:${incident.id}`}
                  className={cn(
                    "w-full rounded-lg border p-3 text-left transition-colors hover:bg-muted/60",
                    selected?.id === incident.id && "border-primary/50 bg-muted"
                  )}
                  onClick={() => onSelect(incident)}
                  data-testid="incident-row"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate font-mono text-sm">{incident.id}</div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {new Date(incident.capturedAt).toLocaleString()} · {incident.source}
                      </div>
                    </div>
                    <Badge variant={incident.state === "rejected" ? "destructive" : "secondary"}>
                      {t(`states.${incident.state}`)}
                    </Badge>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span>{t(`filters.sources.${incident.runtime}`)}</span>
                    <span>{formatBytes(incident.sizeBytes)}</span>
                    {incident.receiptCode && (
                      <span className="font-mono">{incident.receiptCode}</span>
                    )}
                  </div>
                </button>
              ))
            )}
          </div>
        </ScrollArea>
      </section>

      {selected && (
        <aside
          className="relative hidden shrink-0 border-l xl:block"
          style={{ width: detailWidth }}
          data-testid="incident-detail-pane"
        >
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label={t("detail.resize")}
            tabIndex={0}
            className={cn(
              "absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize touch-none",
              detailResize.dragging && "bg-primary/10"
            )}
            onPointerDown={detailResize.onPointerDown}
            onPointerMove={detailResize.onPointerMove}
            onPointerUp={detailResize.onPointerUp}
            onKeyDown={detailResize.onKeyDown}
            onDoubleClick={detailResize.onDoubleClick}
          />
          <IncidentDetail
            key={selected.id}
            incident={selected}
            preview={preview}
            previewLoading={previewLoading}
            onDelete={() => onDelete(selected)}
          />
        </aside>
      )}
    </div>
  )
}

function IncidentDetail({
  incident,
  preview,
  previewLoading,
  onDelete,
}: {
  incident: DiagnosticIncidentSummary
  preview: unknown
  previewLoading: boolean
  onDelete: () => void
}) {
  const t = useTranslations("logging.workspace")
  const [includeMinidump, setIncludeMinidump] = useState(false)
  const [includeScreenshot, setIncludeScreenshot] = useState(false)
  return (
    <ScrollArea className="h-full">
      <div className="space-y-4 p-4">
        <div>
          <h3 className="font-semibold">{t("detail.title")}</h3>
          <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{incident.id}</p>
        </div>
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div className="rounded-md border p-2">
            <div className="text-muted-foreground">{t("detail.runtime")}</div>
            <div className="mt-1 font-medium">{t(`filters.sources.${incident.runtime}`)}</div>
          </div>
          <div className="rounded-md border p-2">
            <div className="text-muted-foreground">{t("detail.state")}</div>
            <div className="mt-1 font-medium">{t(`states.${incident.state}`)}</div>
          </div>
        </div>
        <Separator />
        <div>
          <div className="text-sm font-medium">{t("detail.previewTitle")}</div>
          <p className="text-xs text-muted-foreground">{t("detail.previewDescription")}</p>
          <pre className="mt-2 max-h-72 overflow-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap">
            {previewLoading
              ? t("detail.loading")
              : displayPreview(preview) || t("detail.noPreview")}
          </pre>
        </div>
        <div className="space-y-3">
          <div className="text-sm font-medium">{t("consent.title")}</div>
          <p className="text-xs text-muted-foreground">{t("consent.description")}</p>
          <label className="flex items-start gap-2 rounded-md border p-3 text-sm">
            <Checkbox
              checked={includeMinidump}
              onCheckedChange={(checked) => setIncludeMinidump(checked === true)}
            />
            <span>
              <span className="font-medium">{t("consent.minidump")}</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                {t("consent.minidumpDescription")}
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2 rounded-md border p-3 text-sm">
            <Checkbox
              checked={includeScreenshot}
              onCheckedChange={(checked) => setIncludeScreenshot(checked === true)}
            />
            <span>
              <span className="font-medium">{t("consent.screenshot")}</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                {t("consent.screenshotDescription")}
              </span>
            </span>
          </label>
          <Textarea
            placeholder={t("consent.descriptionPlaceholder")}
            aria-label={t("consent.descriptionLabel")}
          />
        </div>
        <Button variant="destructive" className="w-full" onClick={onDelete}>
          <Trash2Icon className="size-4" />
          {t("delete.action")}
        </Button>
      </div>
    </ScrollArea>
  )
}
