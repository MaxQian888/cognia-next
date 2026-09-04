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
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import {
  CircleCheckIcon,
  CircleDotIcon,
  CircleSlashIcon,
  DownloadIcon,
  RefreshCwIcon,
  ShieldAlertIcon,
} from "lucide-react"

import { Alert, AlertDescription } from "@/components/ui/alert"
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
import { Switch } from "@/components/ui/switch"
import { Spinner } from "@/components/ui/spinner"
import type { useTriageConsole } from "@/hooks/diagnostic-service/use-triage-console"
import type { GroupStatus } from "@/lib/diagnostic-service/types"
import { cn } from "@/lib/utils"

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

const GROUP_STATUSES: GroupStatus[] = ["open", "suppressed", "resolved"]

const STATUS_ICON = {
  open: CircleDotIcon,
  suppressed: CircleSlashIcon,
  resolved: CircleCheckIcon,
} as const

export interface ServiceConsoleWorkspaceProps {
  console: ReturnType<typeof useTriageConsole>
  /** Whether a service is configured at all. */
  configured: boolean
  /** Whether the current grant satisfies a role. */
  can: (role: "viewer" | "triager" | "admin") => boolean
  onConfigure: () => void
}

export function ServiceConsoleWorkspace({
  console: triage,
  configured,
  can,
  onConfigure,
}: ServiceConsoleWorkspaceProps) {
  const t = useTranslations("logging.workspace.console")
  const [assigneeDraft, setAssigneeDraft] = useState("")

  if (!configured) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <Empty className="max-w-md border-y py-8" data-testid="console-unconfigured">
          <EmptyHeader>
            <EmptyTitle className="text-base">{t("notConnected")}</EmptyTitle>
            <EmptyDescription>{t("notConnectedDescription")}</EmptyDescription>
          </EmptyHeader>
          <Button variant="outline" size="sm" className="mt-3" onClick={onConfigure}>
            {t("configure")}
          </Button>
        </Empty>
      </div>
    )
  }

  if (!triage.readable) {
    // A configured connection whose grant sits below Viewer. Said plainly
    // rather than rendering an empty list that looks like "no crashes".
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <Empty className="max-w-md border-y py-8" data-testid="console-insufficient-role">
          <EmptyHeader>
            <EmptyTitle className="text-base">{t("insufficientRole")}</EmptyTitle>
            <EmptyDescription>{t("insufficientRoleDescription")}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    )
  }

  const detail = triage.detail
  const triager = can("triager")

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
                      triage.selectedGroupId === group.id && "border-primary/50 bg-muted"
                    )}
                    onClick={() => triage.selectGroup(group.id)}
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
                      <span>
                        {t("groups.lastSeen", {
                          when: new Date(group.lastSeenAt).toLocaleString(),
                        })}
                      </span>
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

      {detail && (
        <aside
          className="hidden w-[420px] shrink-0 border-l xl:block"
          data-testid="console-detail-pane"
        >
          <ScrollArea className="h-full">
            <div className="space-y-4 p-4">
              <div>
                <h3 className="font-semibold">
                  {detail.group.exception} · {detail.group.module}
                </h3>
                <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
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
                <dd>{new Date(detail.group.firstSeenAt).toLocaleString()}</dd>
                <dt className="text-muted-foreground">{t("group.lastSeen")}</dt>
                <dd>{new Date(detail.group.lastSeenAt).toLocaleString()}</dd>
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
                          {incident.processingState} ·{" "}
                          {new Date(incident.createdAt).toLocaleString()}
                        </div>
                      </div>
                    </Button>
                  ))
                )}
              </div>

              {triage.incidentDetail && (
                <div className="space-y-3 rounded-md border p-3" data-testid="console-incident">
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-mono text-xs">
                      {triage.incidentDetail.incident.supportCode}
                    </div>
                    <Button size="sm" variant="ghost" onClick={triage.closeIncident}>
                      {t("incident.close")}
                    </Button>
                  </div>

                  <div>
                    <div className="text-xs font-medium">{t("incident.artifacts")}</div>
                    {triage.incidentDetail.artifacts.length === 0 ? (
                      <p className="text-xs text-muted-foreground">{t("incident.noArtifacts")}</p>
                    ) : (
                      <ul className="mt-1 space-y-1">
                        {triage.incidentDetail.artifacts.map((part) => (
                          <li
                            key={part.partNumber}
                            className="flex items-center justify-between gap-2 text-xs"
                          >
                            <span className="truncate">
                              #{part.partNumber} · {part.artifactKind} · {part.storedBytes}
                            </span>
                            {triager && (
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={triage.busy}
                                onClick={() =>
                                  void triage.downloadArtifact(
                                    triage.incidentDetail!.incident.id,
                                    part.partNumber
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
                    {triage.incidentDetail.audit.length === 0 ? (
                      <p className="text-xs text-muted-foreground">{t("incident.noAudit")}</p>
                    ) : (
                      <ul className="mt-1 space-y-1 text-xs text-muted-foreground">
                        {triage.incidentDetail.audit.map((event) => (
                          <li key={event.id} className="truncate">
                            <span className="font-mono">{event.action}</span> ·{" "}
                            {event.actorId ?? t("incident.system")} ·{" "}
                            {new Date(event.occurredAt).toLocaleString()}
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
                          onCheckedChange={(checked) => triage.setRawMinidumpAccess(checked)}
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
          </ScrollArea>
        </aside>
      )}
    </div>
  )
}
