"use client"

/**
 * The `/logs` Service channel — the diagnostic service's triage console.
 *
 * ADR-0102 called for "an OIDC-protected service console" and the service grew
 * every column one needs (fingerprint groups, assignee, suppression, an
 * immutable audit trail, a per-tenant raw-minidump opt-in) without anything
 * ever reading them back. This is that console, in the app rather than served
 * by the service, for the same reason `/servers` puts the Ops Controller's
 * console here: the design system, the i18n wiring and the CSP-safe transport
 * already exist, and an operator is a Cognia user.
 *
 * Role-shaped rather than error-shaped: a Viewer sees the list and the detail,
 * a Triager additionally gets the status and assignee controls and raw
 * artifact reads, an Admin gets the tenant policy. What an operator cannot use
 * is not rendered, instead of being rendered and answering 403.
 *
 * Before the console renders it says which of five states it is in — still
 * loading (the stored connection, or the role probe), not connected, connected
 * without an identity session, a session whose role is below Viewer (or could
 * not be confirmed), ready — because each needs a different next step and an
 * empty list answers none of them.
 *
 * The group detail is a resizable pane at `xl` (sharing the workspace's
 * `detailWidth` with the other channels) and a sheet below it. The sheet's
 * `open` is gated in JS on the breakpoint: a CSS-hidden sheet still mounts its
 * overlay and focus trap.
 */

import { useCallback, useState } from "react"
import { useFormatter, useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  CircleCheckIcon,
  CircleDotIcon,
  CircleSlashIcon,
  DownloadIcon,
  KeyRoundIcon,
  RefreshCwIcon,
  ShieldAlertIcon,
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
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
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
import { Switch } from "@/components/ui/switch"
import { Spinner } from "@/components/ui/spinner"
import { formatByteSize } from "@/components/logging/incident-workspace"
import type { DiagnosticRoleStatus } from "@/hooks/diagnostic-service/use-diagnostic-connection"
import type { useTriageConsole } from "@/hooks/diagnostic-service/use-triage-console"
import { useEdgeResize, useIsNarrow, useMediaQuery } from "@/hooks/ui"
import { downloadBlob } from "@/lib/files/download"
import {
  isArtifactKind,
  isAuditAction,
  isIncidentProcessingState,
  type GroupStatus,
} from "@/lib/diagnostic-service/types"
import { cn } from "@/lib/utils"
import {
  DEFAULT_DETAIL_WIDTH,
  DETAIL_WIDTH_MAX,
  DETAIL_WIDTH_MIN,
  useLogWorkspaceStore,
} from "@/stores/logging/log-workspace-store"

/** Codes the console has a translated string for; anything else degrades. */
export const CONSOLE_ERROR_CODES = [
  "insufficient_grant_scope",
  "raw_minidump_access_disabled",
  "invalid_oidc_session",
  "session_token_missing",
  "group_not_found",
  "incident_not_found",
  "network_unavailable",
  "console_failed",
] as const

export type ConsoleErrorCode = (typeof CONSOLE_ERROR_CODES)[number]

export function translatableConsoleCode(code: string): ConsoleErrorCode {
  return (CONSOLE_ERROR_CODES as readonly string[]).includes(code)
    ? (code as ConsoleErrorCode)
    : "console_failed"
}

/** The breakpoint the detail becomes a pane at — Tailwind's `xl`. */
export const CONSOLE_DETAIL_PANE_QUERY = "(min-width: 1280px)"

/** `<supportCode>-part<N>.<kind>`: what a downloaded artifact is saved as. */
export function artifactFilename(supportCode: string, partNumber: number, kind: string): string {
  const safeCode = supportCode.replace(/[^A-Za-z0-9_-]/g, "_") || "incident"
  const safeKind = kind.replace(/[^A-Za-z0-9_-]/g, "_") || "bin"
  return `${safeCode}-part${partNumber}.${safeKind}`
}

const GROUP_STATUSES: GroupStatus[] = ["open", "suppressed", "resolved"]

const STATUS_ICON = {
  open: CircleDotIcon,
  suppressed: CircleSlashIcon,
  resolved: CircleCheckIcon,
} as const

export interface ServiceConsoleWorkspaceProps {
  console: ReturnType<typeof useTriageConsole>
  /** Whether a service is configured at all (`useDiagnosticConnection().connection`). */
  configured: boolean
  /** Whether an identity session is stored (`useDiagnosticConnection().authenticated`). */
  authenticated: boolean
  /** The stored connection is still being read (`useDiagnosticConnection().loading`). */
  loading: boolean
  /**
   * Whether the operator's role is known (`useDiagnosticConnection().roleStatus`).
   * Optional for callers that only ever pass a known role; `probing` renders
   * the loading state and `failed` the could-not-confirm state.
   */
  roleStatus?: DiagnosticRoleStatus
  /** The service's code for a failed role probe (`roleErrorCode`). */
  roleErrorCode?: string | null
  /** Retry the role probe (`probeRole`). */
  onRetryRole?: () => void
  /** Whether the current grant satisfies a role. */
  can: (role: "viewer" | "triager" | "admin") => boolean
  onConfigure: () => void
}

/** A centred empty state for the gates before the console itself. */
function ConsoleGate({
  testId,
  title,
  description,
  children,
}: {
  testId: string
  title: string
  description: string
  children?: React.ReactNode
}) {
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <Empty className="max-w-md border-y py-8" data-testid={testId}>
        <EmptyHeader>
          <EmptyTitle className="text-base">{title}</EmptyTitle>
          <EmptyDescription>{description}</EmptyDescription>
        </EmptyHeader>
        {children}
      </Empty>
    </div>
  )
}

export function ServiceConsoleWorkspace({
  console: triage,
  configured,
  authenticated,
  loading,
  roleStatus = "known",
  roleErrorCode = null,
  onRetryRole,
  can,
  onConfigure,
}: ServiceConsoleWorkspaceProps) {
  const t = useTranslations("logging.workspace.console")

  if (loading || roleStatus === "probing") {
    return (
      <div
        className="flex flex-1 items-center justify-center gap-2 p-10 text-sm text-muted-foreground"
        data-testid="console-loading"
        role="status"
      >
        <Spinner className="size-4" />
        {loading ? t("gates.loading") : t("gates.probing")}
      </div>
    )
  }

  if (!configured) {
    return (
      <ConsoleGate
        testId="console-unconfigured"
        title={t("notConnected")}
        description={t("notConnectedDescription")}
      >
        <Button variant="outline" size="sm" className="mt-3" onClick={onConfigure}>
          {t("configure")}
        </Button>
      </ConsoleGate>
    )
  }

  if (!authenticated) {
    // Configured for submitting this device's own crashes, which needs no
    // session. Reading everyone's needs one, and an empty list would not say so.
    return (
      <ConsoleGate
        testId="console-session-required"
        title={t("gates.sessionRequired")}
        description={t("gates.sessionRequiredDescription")}
      >
        <Button variant="outline" size="sm" className="mt-3" onClick={onConfigure}>
          <KeyRoundIcon className="size-4" />
          {t("configure")}
        </Button>
      </ConsoleGate>
    )
  }

  if (roleStatus === "failed") {
    return (
      <ConsoleGate
        testId="console-role-failed"
        title={t("gates.roleFailed")}
        description={t(`errors.${translatableConsoleCode(roleErrorCode ?? "console_failed")}`)}
      >
        <div className="mt-3 flex flex-wrap justify-center gap-2">
          {onRetryRole ? (
            <Button variant="outline" size="sm" onClick={onRetryRole}>
              <RefreshCwIcon className="size-4" />
              {t("gates.retry")}
            </Button>
          ) : null}
          <Button variant="ghost" size="sm" onClick={onConfigure}>
            {t("configure")}
          </Button>
        </div>
      </ConsoleGate>
    )
  }

  if (!triage.readable) {
    // A grant that sits below Viewer. Said plainly rather than rendering an
    // empty list that looks like "no crashes".
    return (
      <ConsoleGate
        testId="console-insufficient-role"
        title={t("insufficientRole")}
        description={t("insufficientRoleDescription")}
      />
    )
  }

  return <ReadyConsole triage={triage} can={can} />
}

function ReadyConsole({
  triage,
  can,
}: {
  triage: ReturnType<typeof useTriageConsole>
  can: (role: "viewer" | "triager" | "admin") => boolean
}) {
  const t = useTranslations("logging.workspace.console")
  const format = useFormatter()
  const wide = useMediaQuery(CONSOLE_DETAIL_PANE_QUERY)
  const narrow = useIsNarrow()
  const detailWidth = useLogWorkspaceStore((state) => state.detailWidth)
  const setDetailWidth = useLogWorkspaceStore((state) => state.setDetailWidth)
  // Whether the user asked for the detail below `xl`; a selection carried over
  // from a deep link opens the pane at `xl` but must not throw a sheet over a
  // narrow screen on arrival.
  const [sheetOpen, setSheetOpen] = useState(false)

  const detailResize = useEdgeResize({
    width: detailWidth,
    min: DETAIL_WIDTH_MIN,
    max: DETAIL_WIDTH_MAX,
    edge: "left",
    onChange: setDetailWidth,
    onReset: () => setDetailWidth(DEFAULT_DETAIL_WIDTH),
  })

  const selectedGroupId = triage.selectedGroupId
  const formatWhen = useCallback(
    (iso: string) => format.dateTime(new Date(iso), { dateStyle: "medium", timeStyle: "short" }),
    [format]
  )

  const detailBody = selectedGroupId ? (
    <GroupDetailPanel triage={triage} can={can} formatWhen={formatWhen} />
  ) : null

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden" data-testid="service-console">
      <section className="flex min-w-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-2 border-b p-3">
          <Select
            value={triage.filters.status}
            onValueChange={(value) =>
              triage.setFilters({ ...triage.filters, status: value as GroupStatus | "all" })
            }
          >
            <SelectTrigger className="h-8 w-full sm:w-[150px]" aria-label={t("filters.status")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="all">{t("filters.statusAll")}</SelectItem>
                {GROUP_STATUSES.map((status) => (
                  <SelectItem key={status} value={status}>
                    {t(`statuses.${status}`)}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <Input
            className="h-8 w-full sm:w-[220px]"
            value={triage.filters.search}
            onChange={(event) =>
              triage.setFilters({ ...triage.filters, search: event.target.value })
            }
            placeholder={t("filters.search")}
            aria-label={t("filters.searchLabel")}
          />
          <Input
            className="h-8 w-full sm:w-[180px]"
            value={triage.filters.assignedTo}
            onChange={(event) =>
              triage.setFilters({ ...triage.filters, assignedTo: event.target.value })
            }
            placeholder={t("filters.assignee")}
            aria-label={t("filters.assigneeLabel")}
          />
          <Button
            variant="outline"
            size="sm"
            className="h-8 w-full sm:ml-auto sm:w-auto"
            onClick={triage.refresh}
            disabled={triage.loading}
          >
            <RefreshCwIcon className={cn("size-4", triage.loading && "animate-spin")} />
            {t("refresh")}
          </Button>
        </div>

        {triage.errorCode && (
          <Alert variant="destructive" className="m-3 w-auto" data-testid="console-error">
            <AlertDescription>
              {t(`errors.${translatableConsoleCode(triage.errorCode)}`)}
            </AlertDescription>
          </Alert>
        )}

        <ScrollArea className="flex-1">
          <div className="w-full min-w-0 space-y-2 p-3" data-testid="console-group-list">
            {triage.loading && triage.groups.length === 0 ? (
              <div className="flex items-center justify-center gap-2 p-10 text-sm text-muted-foreground">
                <Spinner className="size-4" />
                {t("groups.loading")}
              </div>
            ) : triage.groups.length === 0 ? (
              <Empty className="w-full min-w-0 border-y py-8">
                <EmptyHeader className="w-full min-w-0">
                  <EmptyTitle className="text-base">{t("groups.empty")}</EmptyTitle>
                  <EmptyDescription>{t("groups.emptyDescription")}</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              triage.groups.map((group) => {
                const StatusIcon = STATUS_ICON[group.status]
                return (
                  <Button
                    type="button"
                    variant="ghost"
                    key={group.id}
                    className={cn(
                      "h-auto w-full justify-start rounded-none border-y p-3 text-left whitespace-normal",
                      selectedGroupId === group.id && "border-primary/50 bg-muted"
                    )}
                    onClick={() => {
                      triage.selectGroup(group.id)
                      setSheetOpen(true)
                    }}
                    data-testid="console-group-row"
                  >
                    <div className="flex w-full items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium">
                          {group.exception} · {group.module}
                        </div>
                        <div className="mt-1 truncate font-mono text-xs text-muted-foreground">
                          {group.fingerprint}
                        </div>
                      </div>
                      <Badge variant={group.status === "open" ? "secondary" : "outline"}>
                        <StatusIcon className="size-3" />
                        {t(`statuses.${group.status}`)}
                      </Badge>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <span>{t("groups.count", { count: group.incidentCount })}</span>
                      <span>{group.platform}</span>
                      <span>{t("groups.lastSeen", { when: formatWhen(group.lastSeenAt) })}</span>
                      {group.regressionCount > 0 && (
                        <Badge variant="destructive">
                          {t("groups.regression", { count: group.regressionCount })}
                        </Badge>
                      )}
                      {group.assignedTo && <Badge variant="outline">{group.assignedTo}</Badge>}
                    </div>
                  </Button>
                )
              })
            )}
          </div>
        </ScrollArea>
      </section>

      {wide && detailBody ? (
        <aside
          className="relative shrink-0 border-l"
          style={{ width: detailWidth }}
          data-testid="console-detail-pane"
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
          {detailBody}
        </aside>
      ) : null}

      <Sheet open={!wide && sheetOpen && detailBody !== null} onOpenChange={setSheetOpen}>
        <SheetContent
          side={narrow ? "bottom" : "right"}
          className={cn("p-0", narrow ? "h-dvh max-h-dvh" : "w-[min(92vw,560px)] sm:max-w-none")}
          data-testid="console-detail-drawer"
        >
          <SheetHeader className="sr-only">
            <SheetTitle>{t("detail.title")}</SheetTitle>
            <SheetDescription>{t("detail.description")}</SheetDescription>
          </SheetHeader>
          {detailBody}
        </SheetContent>
      </Sheet>
    </div>
  )
}

function GroupDetailPanel({
  triage,
  can,
  formatWhen,
}: {
  triage: ReturnType<typeof useTriageConsole>
  can: (role: "viewer" | "triager" | "admin") => boolean
  formatWhen: (iso: string) => string
}) {
  const t = useTranslations("logging.workspace.console")
  const format = useFormatter()
  const [assigneeDraft, setAssigneeDraft] = useState("")
  /** The raw-minidump value awaiting confirmation, or null when none is. */
  const [pendingRawMinidump, setPendingRawMinidump] = useState<boolean | null>(null)
  const detail = triage.detail
  const triager = can("triager")

  const download = useCallback(
    async (incidentId: string, supportCode: string, partNumber: number, kind: string) => {
      const bytes = await triage.downloadArtifact(incidentId, partNumber)
      // A refusal is already on screen as the console's error code; the toast
      // is the per-click answer to "did my download happen?".
      if (!bytes) {
        toast.error(t("incident.downloadFailed"))
        return
      }
      const filename = artifactFilename(supportCode, partNumber, kind)
      try {
        const outcome = await downloadBlob(
          new Blob([bytes as BlobPart], { type: "application/octet-stream" }),
          filename
        )
        if (outcome.kind === "error") toast.error(t("incident.downloadFailed"))
        else if (outcome.kind !== "cancelled") {
          toast.success(t("incident.downloaded", { filename }))
        }
      } catch {
        toast.error(t("incident.downloadFailed"))
      }
    },
    [t, triage]
  )

  if (!detail) {
    return (
      <div
        className="flex h-full items-center justify-center gap-2 p-10 text-sm text-muted-foreground"
        data-testid="console-detail-loading"
      >
        <Spinner className="size-4" />
        {t("detail.loading")}
      </div>
    )
  }

  const incidentDetail = triage.incidentDetail

  return (
    <ScrollArea className="h-full">
      <div className="space-y-4 p-4">
        <div>
          <h3 className="font-semibold break-words">
            {detail.group.exception} · {detail.group.module}
          </h3>
          <p className="mt-1 font-mono text-xs break-all text-muted-foreground">
            {detail.group.fingerprint}
          </p>
        </div>

        {triager ? (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              {GROUP_STATUSES.map((status) => (
                <Button
                  key={status}
                  size="sm"
                  variant={detail.group.status === status ? "default" : "outline"}
                  disabled={triage.busy || detail.group.status === status}
                  onClick={() => triage.setStatus(detail.group.id, status)}
                  data-testid={`console-status-${status}`}
                >
                  {t(`statuses.${status}`)}
                </Button>
              ))}
            </div>
            <div className="flex gap-2">
              <Input
                className="h-8"
                value={assigneeDraft}
                onChange={(event) => setAssigneeDraft(event.target.value)}
                placeholder={detail.group.assignedTo ?? t("group.assigneePlaceholder")}
                aria-label={t("group.assignee")}
              />
              <Button
                size="sm"
                disabled={triage.busy || !assigneeDraft.trim()}
                onClick={() => {
                  triage.setAssignee(detail.group.id, assigneeDraft.trim())
                  setAssigneeDraft("")
                }}
              >
                {t("group.assign")}
              </Button>
              {detail.group.assignedTo && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={triage.busy}
                  // Explicit null, not an empty string: the service
                  // discriminates "unassign" from "leave alone".
                  onClick={() => triage.setAssignee(detail.group.id, null)}
                  data-testid="console-unassign"
                >
                  {t("group.unassign")}
                </Button>
              )}
            </div>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">{t("group.readOnly")}</p>
        )}

        <Separator />
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          <dt className="text-muted-foreground">{t("group.platform")}</dt>
          <dd>{detail.group.platform}</dd>
          <dt className="text-muted-foreground">{t("group.buildFamily")}</dt>
          <dd className="truncate">{detail.group.compatibleBuildFamily || "—"}</dd>
          <dt className="text-muted-foreground">{t("group.firstSeen")}</dt>
          <dd>{formatWhen(detail.group.firstSeenAt)}</dd>
          <dt className="text-muted-foreground">{t("group.lastSeen")}</dt>
          <dd>{formatWhen(detail.group.lastSeenAt)}</dd>
        </dl>

        <Separator />
        <div className="space-y-2">
          <div className="text-sm font-medium">{t("incidents.title")}</div>
          {detail.incidents.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("incidents.empty")}</p>
          ) : (
            detail.incidents.map((incident) => (
              <Button
                key={incident.id}
                type="button"
                variant="ghost"
                className="h-auto w-full justify-start rounded-md border p-2 text-left whitespace-normal"
                onClick={() => triage.openIncident(incident.id)}
                data-testid="console-incident-row"
              >
                <div className="min-w-0">
                  <div className="font-mono text-xs">{incident.supportCode}</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {isIncidentProcessingState(incident.processingState)
                      ? t(`processingStates.${incident.processingState}`)
                      : t("processingStates.unknown", {
                          state: String(incident.processingState),
                        })}{" "}
                    · {formatWhen(incident.createdAt)}
                  </div>
                </div>
              </Button>
            ))
          )}
        </div>

        {incidentDetail && (
          <div className="space-y-3 rounded-md border p-3" data-testid="console-incident">
            <div className="flex items-center justify-between gap-2">
              <div className="font-mono text-xs">{incidentDetail.incident.supportCode}</div>
              <Button size="sm" variant="ghost" onClick={triage.closeIncident}>
                {t("incident.close")}
              </Button>
            </div>

            <div>
              <div className="text-xs font-medium">{t("incident.artifacts")}</div>
              {incidentDetail.artifacts.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t("incident.noArtifacts")}</p>
              ) : (
                <ul className="mt-1 space-y-1">
                  {incidentDetail.artifacts.map((part) => (
                    <li
                      key={part.partNumber}
                      className="flex items-center justify-between gap-2 text-xs"
                    >
                      <span className="truncate">
                        {t("incident.part", {
                          number: part.partNumber,
                          kind: artifactKindLabel(t, part.artifactKind),
                          size: formatByteSize(format, part.storedBytes),
                        })}
                      </span>
                      {triager && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={triage.busy}
                          onClick={() =>
                            void download(
                              incidentDetail.incident.id,
                              incidentDetail.incident.supportCode,
                              part.partNumber,
                              part.artifactKind
                            )
                          }
                          data-testid="console-artifact-download"
                        >
                          <DownloadIcon className="size-3.5" />
                          {t("incident.download")}
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div>
              <div className="text-xs font-medium">{t("incident.audit")}</div>
              {incidentDetail.audit.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t("incident.noAudit")}</p>
              ) : (
                <ul className="mt-1 space-y-1 text-xs text-muted-foreground">
                  {incidentDetail.audit.map((event) => (
                    <li key={event.id} className="truncate" title={event.action}>
                      {isAuditAction(event.action)
                        ? t(`auditActions.${event.action.replace(/\./g, "_")}`)
                        : t("auditActions.unknown", { action: event.action })}{" "}
                      · {event.actorId ?? t("incident.system")} · {formatWhen(event.occurredAt)}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}

        {can("admin") && (
          <>
            <Separator />
            <div className="space-y-2" data-testid="console-tenant-policy">
              <div className="text-sm font-medium">{t("policy.title")}</div>
              {triage.tenant ? (
                <label className="flex items-start gap-2 rounded-md border p-3 text-sm">
                  <Switch
                    checked={triage.tenant.rawMinidumpAccessEnabled}
                    // Tenant-wide and audited: confirmed in a dialog, in both
                    // directions, rather than applied on a stray click.
                    onCheckedChange={(checked) => setPendingRawMinidump(checked)}
                    disabled={triage.busy}
                    aria-label={t("policy.rawMinidump")}
                  />
                  <span>
                    <span className="font-medium">{t("policy.rawMinidump")}</span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {t("policy.rawMinidumpDescription")}
                    </span>
                  </span>
                </label>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={triage.loadTenant}
                  disabled={triage.busy}
                >
                  <ShieldAlertIcon className="size-4" />
                  {t("policy.load")}
                </Button>
              )}
            </div>
          </>
        )}
      </div>

      <AlertDialog
        open={pendingRawMinidump !== null}
        onOpenChange={(open) => !open && setPendingRawMinidump(null)}
      >
        <AlertDialogContent data-testid="console-raw-minidump-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingRawMinidump
                ? t("policy.confirmEnableTitle")
                : t("policy.confirmDisableTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingRawMinidump
                ? t("policy.confirmEnableDescription")
                : t("policy.confirmDisableDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("policy.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingRawMinidump !== null) triage.setRawMinidumpAccess(pendingRawMinidump)
                setPendingRawMinidump(null)
              }}
            >
              {pendingRawMinidump ? t("policy.confirmEnable") : t("policy.confirmDisable")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ScrollArea>
  )
}

/** A translated artifact kind; an unknown one shows its raw code under a generic label. */
function artifactKindLabel(t: ReturnType<typeof useTranslations>, kind: string): string {
  return isArtifactKind(kind) ? t(`artifactKinds.${kind}`) : t("artifactKinds.unknown", { kind })
}
