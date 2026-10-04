"use client"

/**
 * The `/logs` Crash reports channel (view id `incidents`): the native crash
 * reports this device captured — Rust panics and minidumps on the desktop, the
 * Capacitor crash plugin's reports on mobile — with their redacted preview,
 * the consent controls that gate submission, and the receipt once sent.
 *
 * What it is not: the Errors channel (`diagnostics`) is logged failures, and
 * the Service channel is what a diagnostic service accepted from everyone.
 *
 *   - **Receipts** are a filter (`receiptsOnly`), not a view: they were only
 *     ever "reports that carry a support code".
 *   - **The source filter** (desktop / mobile) only appears when both runtimes
 *     could hold reports. A device is one or the other, so offering "Mobile"
 *     on a desktop was a filter guaranteed to empty the list.
 *   - **The plain browser** captures no crash reports and says so, rather than
 *     reading as a healthy "nothing crashed".
 *   - **Submission state is per incident** (`IncidentSubmissionApi.stateFor`):
 *     selecting report B while A is sending neither shows B as busy nor
 *     renders A's failure under B.
 *   - **The detail** is a resizable pane at `xl` and a sheet below it, with
 *     the sheet's `open` gated in JS so no overlay or focus trap is left behind
 *     at `xl`.
 *   - **Destructive actions confirm**: withdraw and remote delete here; the
 *     local delete through the caller's dialog (`onDelete`).
 */

import { useCallback, useState } from "react"
import { useFormatter, useTranslations } from "next-intl"
import {
  MonitorSmartphoneIcon,
  ReceiptTextIcon,
  RefreshCwIcon,
  SendIcon,
  ShieldOffIcon,
  Trash2Icon,
} from "lucide-react"

import { Alert, AlertDescription } from "@/components/ui/alert"
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
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Textarea } from "@/components/ui/textarea"
import { Toggle } from "@/components/ui/toggle"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Spinner } from "@/components/ui/spinner"
import type {
  DiagnosticIncidentSummary,
  IncidentRuntime,
} from "@/hooks/logging/use-diagnostic-incidents"
import {
  incidentSubmissionKey,
  type IncidentSubmissionApi,
} from "@/hooks/logging/use-incident-submission"
import { useIsNarrow, useMediaQuery, type useEdgeResize } from "@/hooks/ui"
import { isIncidentProcessingState } from "@/lib/diagnostic-service/types"
import { cn } from "@/lib/utils"
import {
  INCIDENT_STATE_FILTERS,
  type IncidentStateFilter,
  type LogWorkspaceSource,
} from "@/stores/logging/log-workspace-store"

/**
 * What the channel needs in order to actually submit something — exactly what
 * `useIncidentSubmission` returns.
 */
export type IncidentSubmissionControls = IncidentSubmissionApi

/**
 * Failure codes the panel has a translated string for.
 *
 * An allowlist rather than `t.has`: the set of codes is a contract between the
 * native command, the hook and this panel, and pinning it here is what makes a
 * new service code degrade to the generic message instead of rendering a
 * missing-key placeholder at the user.
 */
export const SUBMISSION_ERROR_CODES = [
  "ingest_disabled",
  "unauthorized",
  "network_unavailable",
  "package_invalid",
  "malformed_response",
  "report_not_found",
  "submission_not_found",
  "desktop_only",
  "not_configured",
  "installation_proof_unsupported",
  "submission_failed",
] as const

export type SubmissionErrorCode = (typeof SUBMISSION_ERROR_CODES)[number]

/** Map any code onto one this panel can actually render. */
export function translatableErrorCode(code: string): SubmissionErrorCode {
  return (SUBMISSION_ERROR_CODES as readonly string[]).includes(code)
    ? (code as SubmissionErrorCode)
    : "submission_failed"
}

export interface IncidentConsent {
  includeMinidump: boolean
  includeScreenshot: boolean
  description: string
}

/** Every option of the lifecycle filter, in the service's own vocabulary. */
export const INCIDENT_STATES: readonly IncidentStateFilter[] = INCIDENT_STATE_FILTERS

/**
 * Capture sources with a translated label. Anything else (a collector a newer
 * plugin adds) renders as its raw code under a generic label.
 */
export const INCIDENT_SOURCES = [
  "panic",
  "native",
  "unknown",
  "android-acra",
  "android-application-exit",
  "ios-kscrash",
  "ios-metrickit",
] as const

/** The breakpoint the detail becomes a pane at — Tailwind's `xl`. */
export const INCIDENT_DETAIL_PANE_QUERY = "(min-width: 1280px)"

type Formatter = ReturnType<typeof useFormatter>
type Translator = ReturnType<typeof useTranslations>

const BYTE_UNITS = ["byte", "kilobyte", "megabyte", "gigabyte"] as const

/** A byte count with a localized unit (`2 KB`, `2 kB`, `2 KB`…), never a bare number. */
export function formatByteSize(format: Formatter, bytes: number): string {
  let value = Math.max(0, bytes)
  let unit = 0
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  return format.number(value, {
    style: "unit",
    unit: BYTE_UNITS[unit],
    unitDisplay: "short",
    maximumFractionDigits: unit === 0 ? 0 : 1,
  })
}

export function displayPreview(preview: unknown): string {
  if (typeof preview === "string") return preview
  if (preview === null || preview === undefined) return ""
  return JSON.stringify(preview, null, 2)
}

function sourceLabel(t: Translator, source: string): string {
  return (INCIDENT_SOURCES as readonly string[]).includes(source)
    ? t(`sources.${source}`)
    : t("sources.other", { source })
}

function formatWhen(format: Formatter, iso: string): string {
  return format.dateTime(new Date(iso), { dateStyle: "medium", timeStyle: "short" })
}

export interface IncidentWorkspaceProps {
  incidents: DiagnosticIncidentSummary[]
  loading: boolean
  error: Error | null
  selected: DiagnosticIncidentSummary | null
  preview: unknown
  previewLoading: boolean
  /**
   * The runtimes on this device that can hold reports
   * (`useDiagnosticIncidents().runtimes`). Empty in the plain browser.
   */
  runtimes: readonly IncidentRuntime[]
  activeSource: LogWorkspaceSource
  incidentStateFilter: IncidentStateFilter
  onSourceChange: (source: LogWorkspaceSource) => void
  onStateChange: (state: IncidentStateFilter) => void
  onRefresh: () => void
  onSelect: (incident: DiagnosticIncidentSummary) => void
  /** Asks to delete the local report; the caller confirms. */
  onDelete: (incident: DiagnosticIncidentSummary) => void
  detailWidth: number
  detailResize: ReturnType<typeof useEdgeResize>
  receiptsOnly: boolean
  onReceiptsOnlyChange: (receiptsOnly: boolean) => void
  submission?: IncidentSubmissionControls
}

export function IncidentWorkspace({
  incidents,
  loading,
  error,
  selected,
  preview,
  previewLoading,
  runtimes,
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
  submission,
}: IncidentWorkspaceProps) {
  const t = useTranslations("logging.workspace")
  const format = useFormatter()
  const wide = useMediaQuery(INCIDENT_DETAIL_PANE_QUERY)
  const narrow = useIsNarrow()
  // The list auto-selects; only a click means "show me the detail" below `xl`.
  const [sheetOpen, setSheetOpen] = useState(false)

  const collects = runtimes.length > 0
  const showSourceFilter = runtimes.length > 1
  const selectedKey = selected ? incidentSubmissionKey(selected) : null

  if (!collects && !loading && !error && incidents.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <Empty className="max-w-md border-y py-8" data-testid="incident-uncollected">
          <EmptyHeader>
            <MonitorSmartphoneIcon className="mx-auto size-6 text-muted-foreground" aria-hidden />
            <EmptyTitle className="text-base">{t("incidents.uncollectedTitle")}</EmptyTitle>
            <EmptyDescription>{t("incidents.uncollectedDescription")}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    )
  }

  const detail = selected ? (
    <IncidentDetail
      key={incidentSubmissionKey(selected)}
      incident={selected}
      preview={preview}
      previewLoading={previewLoading}
      onDelete={() => onDelete(selected)}
      submission={submission}
    />
  ) : null

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <section className="flex min-w-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-2 border-b p-3">
          {showSourceFilter ? (
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
          ) : null}
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
                <Spinner className="size-4" />
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
              incidents.map((incident) => {
                const key = incidentSubmissionKey(incident)
                return (
                  <Button
                    type="button"
                    variant="ghost"
                    key={key}
                    className={cn(
                      "h-auto w-full justify-start rounded-none border-y p-3 text-left whitespace-normal",
                      selectedKey === key && "border-primary/50 bg-muted"
                    )}
                    onClick={() => {
                      onSelect(incident)
                      setSheetOpen(true)
                    }}
                    data-testid="incident-row"
                  >
                    <div className="flex w-full items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate font-mono text-sm">{incident.id}</div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          {formatWhen(format, incident.capturedAt)} ·{" "}
                          {sourceLabel(t, incident.source)}
                        </div>
                      </div>
                      <Badge variant={incident.state === "rejected" ? "destructive" : "secondary"}>
                        {t(`states.${incident.state}`)}
                      </Badge>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      {showSourceFilter ? (
                        <span>{t(`filters.sources.${incident.runtime}`)}</span>
                      ) : null}
                      <span>{formatByteSize(format, incident.sizeBytes)}</span>
                      {incident.receiptCode && (
                        <span className="font-mono">{incident.receiptCode}</span>
                      )}
                    </div>
                  </Button>
                )
              })
            )}
          </div>
        </ScrollArea>
      </section>

      {wide && detail ? (
        <aside
          className="relative shrink-0 border-l"
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
          {detail}
        </aside>
      ) : null}

      <Sheet open={!wide && sheetOpen && detail !== null} onOpenChange={setSheetOpen}>
        <SheetContent
          side={narrow ? "bottom" : "right"}
          className={cn("p-0", narrow ? "h-dvh max-h-dvh" : "w-[min(92vw,560px)] sm:max-w-none")}
          data-testid="incident-detail-drawer"
        >
          <SheetHeader className="sr-only">
            <SheetTitle>{t("detail.title")}</SheetTitle>
            <SheetDescription>{t("detail.description")}</SheetDescription>
          </SheetHeader>
          {detail}
        </SheetContent>
      </Sheet>
    </div>
  )
}

type PendingRemoteAction = "withdraw" | "deleteRemote" | null

export function IncidentDetail({
  incident,
  preview,
  previewLoading,
  onDelete,
  submission,
}: {
  incident: DiagnosticIncidentSummary
  preview: unknown
  previewLoading: boolean
  /** Asks to delete the local report; the caller confirms. */
  onDelete: () => void
  submission?: IncidentSubmissionControls
}) {
  const t = useTranslations("logging.workspace")
  const format = useFormatter()
  const [includeMinidump, setIncludeMinidump] = useState(false)
  const [includeScreenshot, setIncludeScreenshot] = useState(false)
  const [description, setDescription] = useState("")
  const [pendingRemote, setPendingRemote] = useState<PendingRemoteAction>(null)

  const state = submission?.stateFor(incident) ?? null
  const busy = state?.busy ?? false
  const record = incident.submission
  const withdrawn = Boolean(record?.withdrawnAt)
  // A minidump can only be offered when one was actually captured; a panic
  // report has no `.dmp` beside it, and a checkbox that sends nothing is the
  // same lie this panel already had once.
  const minidumpAvailable = incident.artifacts.includes("minidump")
  // The screenshot is taken natively at submission time; the mobile path
  // uploads the plugin's report alone.
  const screenshotAvailable = incident.runtime === "desktop"
  const canSubmit = Boolean(submission && submission.supported && submission.configured && !busy)

  const confirmRemote = useCallback(() => {
    if (!submission || !pendingRemote) return
    if (pendingRemote === "withdraw") submission.onWithdraw(incident)
    else submission.onDeleteRemote(incident)
    setPendingRemote(null)
  }, [incident, pendingRemote, submission])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-start gap-2 border-b p-4">
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold">{t("detail.title")}</h3>
          <p className="mt-1 font-mono text-xs break-all text-muted-foreground">{incident.id}</p>
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-8 shrink-0 text-destructive hover:text-destructive"
              onClick={onDelete}
              aria-label={t("delete.action")}
              data-testid="incident-delete-local"
            >
              <Trash2Icon className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("delete.action")}</TooltipContent>
        </Tooltip>
      </header>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-4 p-4">
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div className="rounded-md border p-2">
              <div className="text-muted-foreground">{t("detail.source")}</div>
              <div className="mt-1 font-medium">{sourceLabel(t, incident.source)}</div>
            </div>
            <div className="rounded-md border p-2">
              <div className="text-muted-foreground">{t("detail.state")}</div>
              <div className="mt-1 font-medium">{t(`states.${incident.state}`)}</div>
            </div>
          </div>

          {record ? (
            <div className="space-y-3" data-testid="incident-receipt">
              <div className="text-sm font-medium">{t("submission.receiptTitle")}</div>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                <dt className="text-muted-foreground">{t("submission.supportCode")}</dt>
                <dd className="font-mono">{record.supportCode || "—"}</dd>
                <dt className="text-muted-foreground">{t("submission.incidentId")}</dt>
                <dd className="truncate font-mono">{record.incidentId}</dd>
                <dt className="text-muted-foreground">{t("submission.processingState")}</dt>
                <dd>
                  {isIncidentProcessingState(record.processingState)
                    ? t(`console.processingStates.${record.processingState}`)
                    : t("console.processingStates.unknown", { state: record.processingState })}
                </dd>
                <dt className="text-muted-foreground">{t("submission.submittedAt")}</dt>
                <dd>{formatWhen(format, record.submittedAt)}</dd>
                <dt className="text-muted-foreground">{t("submission.service")}</dt>
                <dd className="truncate">{record.serviceUrl}</dd>
              </dl>
              <div className="flex flex-wrap gap-1.5">
                {record.includedMinidump && (
                  <Badge variant="outline">{t("submission.includedMinidump")}</Badge>
                )}
                {record.includedScreenshot && (
                  <Badge variant="outline">{t("submission.includedScreenshot")}</Badge>
                )}
                {withdrawn && <Badge variant="destructive">{t("submission.withdrawn")}</Badge>}
              </div>
              {submission && !withdrawn && (
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => submission.onRefresh(incident)}
                    disabled={busy}
                  >
                    <RefreshCwIcon className={cn("size-4", busy && "animate-spin")} />
                    {t("submission.refresh")}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPendingRemote("withdraw")}
                    disabled={busy}
                    title={t("submission.withdrawDescription")}
                  >
                    <ShieldOffIcon className="size-4" />
                    {t("submission.withdraw")}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPendingRemote("deleteRemote")}
                    disabled={busy}
                  >
                    <Trash2Icon className="size-4" />
                    {t("submission.deleteRemote")}
                  </Button>
                </div>
              )}
            </div>
          ) : incident.receiptCode ? (
            // A phone's receipt: the plugin keeps the support code and state,
            // not the service's incident id, so there is nothing to withdraw
            // or delete through from here.
            <div className="space-y-3" data-testid="incident-receipt">
              <div className="text-sm font-medium">{t("submission.receiptTitle")}</div>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                <dt className="text-muted-foreground">{t("submission.supportCode")}</dt>
                <dd className="font-mono">{incident.receiptCode}</dd>
              </dl>
              <p className="text-xs text-muted-foreground">{t("submission.mobileReceiptNote")}</p>
            </div>
          ) : (
            <ConsentSection
              t={t}
              incident={incident}
              submission={submission}
              busy={busy}
              canSubmit={canSubmit}
              minidumpAvailable={minidumpAvailable}
              screenshotAvailable={screenshotAvailable}
              includeMinidump={includeMinidump}
              includeScreenshot={includeScreenshot}
              description={description}
              onIncludeMinidump={setIncludeMinidump}
              onIncludeScreenshot={setIncludeScreenshot}
              onDescription={setDescription}
            />
          )}

          {state?.errorCode && (
            <Alert variant="destructive" data-testid="incident-submit-error">
              <AlertDescription>
                {t(`submission.errors.${translatableErrorCode(state.errorCode)}`)}
              </AlertDescription>
            </Alert>
          )}
          {state?.lastOutcome && (
            <p className="text-xs text-muted-foreground" data-testid="incident-submit-outcome">
              {t("submission.parts", {
                uploaded: state.lastOutcome.uploadedParts,
                resumed: state.lastOutcome.resumedParts,
              })}
              {state.lastOutcome.screenshotUnavailable && (
                <span className="mt-1 block">{t("submission.screenshotUnavailable")}</span>
              )}
            </p>
          )}

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
        </div>
      </ScrollArea>

      <AlertDialog
        open={pendingRemote !== null}
        onOpenChange={(open) => !open && setPendingRemote(null)}
      >
        <AlertDialogContent data-testid="incident-remote-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingRemote === "withdraw"
                ? t("submission.confirmWithdrawTitle")
                : t("submission.confirmDeleteRemoteTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingRemote === "withdraw"
                ? t("submission.withdrawDescription")
                : t("submission.confirmDeleteRemoteDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("submission.confirmCancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={confirmRemote}>
              {pendingRemote === "withdraw"
                ? t("submission.withdraw")
                : t("submission.deleteRemote")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/**
 * The consent form, with Submit at its top so it is reachable without
 * scrolling past the preview. Hidden entirely, with the reason, on a device
 * that has no submission path: a form whose button can never be enabled is a
 * question the user cannot answer.
 */
function ConsentSection({
  t,
  incident,
  submission,
  busy,
  canSubmit,
  minidumpAvailable,
  screenshotAvailable,
  includeMinidump,
  includeScreenshot,
  description,
  onIncludeMinidump,
  onIncludeScreenshot,
  onDescription,
}: {
  t: Translator
  incident: DiagnosticIncidentSummary
  submission?: IncidentSubmissionControls
  busy: boolean
  canSubmit: boolean
  minidumpAvailable: boolean
  screenshotAvailable: boolean
  includeMinidump: boolean
  includeScreenshot: boolean
  description: string
  onIncludeMinidump: (value: boolean) => void
  onIncludeScreenshot: (value: boolean) => void
  onDescription: (value: string) => void
}) {
  if (submission?.checkingSupport) {
    return (
      <div
        className="flex items-center gap-2 text-xs text-muted-foreground"
        data-testid="incident-support-checking"
      >
        <Spinner className="size-3.5" />
        {t("submission.checkingSupport")}
      </div>
    )
  }

  if (submission && !submission.supported) {
    return (
      <div className="space-y-1" data-testid="incident-submission-unsupported">
        <div className="text-sm font-medium">{t("consent.title")}</div>
        <p className="text-xs text-muted-foreground">{t("submission.unsupported")}</p>
      </div>
    )
  }

  return (
    <div className="space-y-3" data-testid="incident-consent">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-medium">{t("consent.title")}</div>
          <p className="text-xs text-muted-foreground">{t("consent.description")}</p>
        </div>
      </div>
      <Button
        className="w-full"
        disabled={!canSubmit}
        data-testid="incident-submit"
        onClick={() =>
          submission?.onSubmit(incident, {
            includeMinidump: minidumpAvailable && includeMinidump,
            includeScreenshot: screenshotAvailable && includeScreenshot,
            description,
          })
        }
      >
        {busy ? <Spinner className="size-4" /> : <SendIcon className="size-4" />}
        {busy ? t("submission.submitting") : t("submission.submit")}
      </Button>
      {submission && !submission.configured ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">{t("submission.notConfigured")}</p>
          <Button variant="outline" size="sm" onClick={submission.onConfigure}>
            {t("submission.configure")}
          </Button>
        </div>
      ) : null}
      {minidumpAvailable && (
        <label className="flex items-start gap-2 rounded-md border p-3 text-sm">
          <Checkbox
            checked={includeMinidump}
            onCheckedChange={(checked) => onIncludeMinidump(checked === true)}
            aria-label={t("consent.minidump")}
          />
          <span>
            <span className="font-medium">{t("consent.minidump")}</span>
            <span className="mt-0.5 block text-xs text-muted-foreground">
              {t("consent.minidumpDescription")}
            </span>
          </span>
        </label>
      )}
      {screenshotAvailable && (
        <label className="flex items-start gap-2 rounded-md border p-3 text-sm">
          <Checkbox
            checked={includeScreenshot}
            onCheckedChange={(checked) => onIncludeScreenshot(checked === true)}
            aria-label={t("consent.screenshot")}
          />
          <span>
            <span className="font-medium">{t("consent.screenshot")}</span>
            <span className="mt-0.5 block text-xs text-muted-foreground">
              {t("consent.screenshotDescription")}
            </span>
          </span>
        </label>
      )}
      <Textarea
        value={description}
        onChange={(event) => onDescription(event.target.value)}
        placeholder={t("consent.descriptionPlaceholder")}
        aria-label={t("consent.descriptionLabel")}
      />
    </div>
  )
}
