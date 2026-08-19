"use client"

/**
 * The `/logs` Incidents channel: locally-retained crash reports, their
 * redacted preview, and the consent controls that gate submission.
 *
 * Lifted out of `diagnostics-workspace.tsx` when that file stopped being a
 * six-view container and became a three-channel shell. Behaviour is unchanged
 * except for `receiptsOnly`, which absorbed the former standalone "Receipts"
 * view — it was never a different surface, only "incidents that carry a
 * receipt code", so it is a filter now.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Loader2Icon, ReceiptTextIcon, RefreshCwIcon, Trash2Icon } from "lucide-react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Textarea } from "@/components/ui/textarea"
import { Toggle } from "@/components/ui/toggle"
import type { DiagnosticIncidentSummary } from "@/hooks/logging/use-diagnostic-incidents"
import type { useEdgeResize } from "@/hooks/ui"
import { cn } from "@/lib/utils"
import type { IncidentStateFilter, LogWorkspaceSource } from "@/stores/logging/log-workspace-store"

export const INCIDENT_STATES: IncidentStateFilter[] = [
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

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function displayPreview(preview: unknown): string {
  if (typeof preview === "string") return preview
  if (preview === null || preview === undefined) return ""
  return JSON.stringify(preview, null, 2)
}

export function IncidentWorkspace({
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
  onReceiptsOnlyChange,
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
  onReceiptsOnlyChange: (receiptsOnly: boolean) => void
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
            <SelectTrigger
              className="h-8 w-full sm:w-[150px]"
              aria-label={t("filters.sourceLabel")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="all">{t("filters.sources.all")}</SelectItem>
                <SelectItem value="desktop">{t("filters.sources.desktop")}</SelectItem>
                <SelectItem value="mobile">{t("filters.sources.mobile")}</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
          <Select
            value={incidentStateFilter}
            onValueChange={(value) => onStateChange(value as IncidentStateFilter)}
          >
            <SelectTrigger className="h-8 w-full sm:w-[170px]" aria-label={t("filters.stateLabel")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {INCIDENT_STATES.map((state) => (
                  <SelectItem key={state} value={state}>
                    {t(`states.${state}`)}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          {/* The former standalone "Receipts" view. */}
          <Toggle
            size="sm"
            pressed={receiptsOnly}
            onPressedChange={onReceiptsOnlyChange}
            className="h-8 gap-1.5 px-2"
            aria-label={t("filters.receiptsOnly")}
            data-testid="incident-receipts-only"
          >
            <ReceiptTextIcon className="size-4" />
            <span className="hidden sm:inline">{t("filters.receiptsOnly")}</span>
          </Toggle>
          <Button
            variant="outline"
            size="sm"
            className="h-8 w-full sm:ml-auto sm:w-auto"
            onClick={onRefresh}
            disabled={loading}
          >
            <RefreshCwIcon className={cn("size-4", loading && "animate-spin")} />
            {t("refresh")}
          </Button>
        </div>
        <ScrollArea className="flex-1">
          <div className="w-full min-w-0 space-y-2 p-3" data-testid="incident-list">
            {error ? (
              <Alert variant="destructive">
                <AlertDescription>{t("incidents.error")}</AlertDescription>
              </Alert>
            ) : loading && incidents.length === 0 ? (
              <div className="flex items-center justify-center gap-2 p-10 text-sm text-muted-foreground">
                <Loader2Icon className="size-4 animate-spin" />
                {t("incidents.loading")}
              </div>
            ) : incidents.length === 0 ? (
              <Empty className="w-full min-w-0 border-y py-8">
                <EmptyHeader className="w-full min-w-0">
                  <EmptyTitle className="text-base">
                    {t(receiptsOnly ? "receipts.emptyTitle" : "incidents.emptyTitle")}
                  </EmptyTitle>
                  <EmptyDescription>
                    {t(receiptsOnly ? "receipts.emptyDescription" : "incidents.emptyDescription")}
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              incidents.map((incident) => (
                <Button
                  type="button"
                  variant="ghost"
                  key={`${incident.runtime}:${incident.id}`}
                  className={cn(
                    "h-auto w-full justify-start rounded-none border-y p-3 text-left whitespace-normal",
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
                </Button>
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

export function IncidentDetail({
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
