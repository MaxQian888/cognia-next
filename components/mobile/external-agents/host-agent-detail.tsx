"use client"

/**
 * One Host configuration, as the phone sees and edits it.
 *
 * The list card can only switch an agent on and pick its permission mode; this
 * screen is where everything else about it lives. Top to bottom:
 *
 *   - **who it is**: mark, name, connection, where its state lives, whether
 *     the Host can run it (and why not), and which configuration it was copied
 *     from;
 *   - **its configuration**: name, description, on/off, permission mode,
 *     state isolation, the session limit, and — folded under "Advanced
 *     settings" — the very connection and tuning fields the add flow uses,
 *     seeded from the saved configuration (`addAgentFormFromConfig`). Saving
 *     is one compare-and-swap against the revision this screen was opened at,
 *     so an edit made meanwhile on another device is reported, never
 *     overwritten;
 *   - **what to do with it**: duplicate (a sheet; the Host copies the secrets)
 *     and remove (confirmed, naming the agent);
 *   - **its siblings**: the other configurations of the same runtime, each
 *     with the settings in which it differs, so "which Codex is the read-only
 *     one" is answered here.
 */

import { useRef, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  AlertCircleIcon,
  BotIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CloudOffIcon,
  CopyIcon,
  GitForkIcon,
  RotateCwIcon,
  SearchXIcon,
  ServerCogIcon,
  Trash2Icon,
} from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { BrandIcon } from "@/components/icons/brand-icon"
import { ConnectionFields } from "@/components/agent/external-agent/add-agent/connection-fields"
import {
  AddAgentCogniaModelField,
  ExecutionTuningFields,
} from "@/components/agent/external-agent/add-agent/execution-tuning-fields"
import { PLANE_WARNING_KEYS } from "@/components/agent/external-agent/add-agent/preset-guidance"
import {
  StateIsolationField,
  effectiveStateIsolation,
} from "@/components/agent/external-agent/add-agent/state-isolation-field"
import { LifecycleStatusNotice } from "@/components/agent/external-agent/lifecycle-status-notice"
import { useAddAgentForm } from "@/hooks/agent/use-add-agent-form"
import { useAddAgentProblemMessage } from "@/hooks/agent/use-add-agent-problem-message"
import { useExternalAgentProcessPlane } from "@/hooks/agent/use-external-agent-process-plane"
import {
  useHostExternalAgentConfigs,
  type HostExternalAgentConfigsState,
} from "@/hooks/agent/use-host-external-agent-configs"
import { PROCESS_PLANE_COMMANDS } from "@/lib/ai/agent/external/capability/process-plane"
import {
  CONNECTION_PROBLEMS,
  addAgentFormFromConfig,
  addAgentFormLaunchTarget,
  addAgentFormPatch,
} from "@/lib/ai/agent/external/config/add-agent-form"
import type { InstanceDifference } from "@/lib/ai/agent/external/config/instance-family"
import type { StoredExternalAgentConfig } from "@/stores/agent/external-agent-store/types"
import type { ExternalAgentConfigRecord } from "@/types/agent/external-agent-config-store"
import type {
  AcpPermissionMode,
  ExternalAgentConfig,
  ExternalAgentStateIsolation,
} from "@/types/agent/external-agent"

import { HOST_UNAVAILABLE_KEY } from "./add-external-agent-form"
import { DuplicateHostAgentSheet } from "./duplicate-host-agent-sheet"
import { HostAgentIsolationChip } from "./host-agent-chips"
import {
  hostAgentName,
  lineageSourceOf,
  presetOf,
  siblingDifferences,
  siblingsOf,
  stateIsolationOf,
} from "./host-agent-family"
import {
  PERMISSION_MODE_LABEL_KEY,
  effectivePermissionMode,
  permissionModesFor,
} from "./permission-modes"
import { RemoveHostAgentDialog } from "./remove-host-agent-dialog"
import { EXTERNAL_AGENTS_ROUTE, externalAgentDetailHref } from "./routes"

/** `mobile.externalAgents` label key per difference the family rules report. */
const DIFFERENCE_LABEL_KEY: Record<InstanceDifference["key"], string> = {
  permissionMode: "diffPermission",
  stateIsolation: "diffIsolation",
  model: "diffModel",
  account: "diffAccount",
  workingDirectory: "diffCwd",
  arguments: "diffArgs",
  sandbox: "diffSandbox",
  network: "diffNetwork",
  endpoint: "diffEndpoint",
  sessionLimit: "diffSessionLimit",
  approvals: "diffApprovals",
}

const SANDBOX_LABEL_KEY: Record<string, string> = {
  readOnly: "sandboxReadOnly",
  workspaceWrite: "sandboxWorkspaceWrite",
  dangerFullAccess: "sandboxDangerFullAccess",
}

/** A compare-and-swap refusal, as the Host words it (`ExternalAgentConfigConflictError`). */
function isConflict(message: string): boolean {
  return /moved to revision|config_conflict/i.test(message)
}

export function HostAgentDetail({ configId }: { configId: string }) {
  const t = useTranslations("mobile.externalAgents")
  const tHost = useTranslations("externalAgent.hostConfigs")
  const router = useRouter()
  const host = useHostExternalAgentConfigs()
  const [pendingRemoval, setPendingRemoval] = useState<ExternalAgentConfigRecord | null>(null)
  const [duplicating, setDuplicating] = useState<ExternalAgentConfigRecord | null>(null)
  // Outside the form on purpose: a refused save re-reads the Host, which can
  // move the revision the form is keyed on, and the reason must survive that.
  const [saveRefused, setSaveRefused] = useState(false)
  const record = host.configs.find((row) => row.configId === configId) ?? null

  if (host.unavailable) {
    return (
      <Empty className="flex-1" data-testid="host-agent-detail-unavailable">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ServerCogIcon />
          </EmptyMedia>
          <EmptyTitle>{tHost("unavailableTitle")}</EmptyTitle>
          <EmptyDescription>{tHost(HOST_UNAVAILABLE_KEY[host.unavailable])}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  if (!record) {
    if (host.loading) return <DetailSkeleton />
    if (host.error !== null && host.configs.length === 0) {
      return (
        <Empty className="flex-1" data-testid="host-agent-detail-load-failed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <CloudOffIcon />
            </EmptyMedia>
            <EmptyTitle>{t("loadFailedTitle")}</EmptyTitle>
            <EmptyDescription className="break-words">
              {t("loadFailed", { message: host.error })}
            </EmptyDescription>
          </EmptyHeader>
          <Button
            variant="outline"
            className="h-11"
            onClick={() => void host.refresh()}
            data-testid="host-agent-detail-retry"
          >
            <RotateCwIcon className="size-4" />
            {t("retry")}
          </Button>
        </Empty>
      )
    }
    return (
      <Empty className="flex-1" data-testid="host-agent-detail-not-found">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <SearchXIcon />
          </EmptyMedia>
          <EmptyTitle>{t("detailNotFoundTitle")}</EmptyTitle>
          <EmptyDescription>{t("detailNotFoundBody")}</EmptyDescription>
        </EmptyHeader>
        <Button asChild variant="outline" className="h-11">
          <Link href={EXTERNAL_AGENTS_ROUTE}>{t("backToList")}</Link>
        </Button>
      </Empty>
    )
  }

  const name = hostAgentName(record)
  const siblings = siblingsOf(record, host.configs)

  const confirmRemoval = async (target: ExternalAgentConfigRecord) => {
    setPendingRemoval(null)
    if (await host.remove(target)) {
      toast.success(t("removed", { name: hostAgentName(target) }))
      router.replace(EXTERNAL_AGENTS_ROUTE)
    }
  }

  return (
    <div className="flex flex-1 flex-col gap-6" data-testid="host-agent-detail">
      <DetailHeader record={record} records={host.configs} />

      {saveRefused && host.error ? (
        <Alert variant="destructive" data-testid="host-agent-detail-save-error">
          <AlertCircleIcon />
          <AlertTitle>{t("saveFailedTitle")}</AlertTitle>
          <AlertDescription className="break-words">
            {isConflict(host.error)
              ? t("saveConflict")
              : t("saveFailed", { message: host.error })}
          </AlertDescription>
        </Alert>
      ) : null}

      {/* Keyed on the revision: once the Host has a newer one (this save, or
          another device's), the form starts again from what is stored. */}
      <HostAgentConfigForm
        key={record.revision}
        record={record}
        host={host}
        onSaveResult={(ok) => setSaveRefused(!ok)}
      />

      <section className="flex flex-col gap-2" aria-labelledby="host-agent-actions-title">
        <h2
          id="host-agent-actions-title"
          className="px-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase"
        >
          {t("actionsTitle")}
        </h2>
        <div className="grid grid-cols-2 gap-2">
          <Button
            variant="outline"
            className="h-11"
            disabled={host.busy}
            onClick={() => setDuplicating(record)}
            aria-label={t("duplicateAria", { name })}
            data-testid="host-agent-detail-duplicate"
          >
            <CopyIcon className="size-4" />
            {t("duplicate")}
          </Button>
          <Button
            variant="outline"
            className="h-11 text-destructive hover:text-destructive"
            disabled={host.busy}
            onClick={() => setPendingRemoval(record)}
            aria-label={t("removeAria", { name })}
            data-testid="host-agent-detail-remove"
          >
            <Trash2Icon className="size-4" />
            {t("deleteConfirm")}
          </Button>
        </div>
      </section>

      {siblings.length > 0 ? <SiblingList record={record} siblings={siblings} /> : null}

      <RemoveHostAgentDialog
        record={pendingRemoval}
        onCancel={() => setPendingRemoval(null)}
        onConfirm={(target) => void confirmRemoval(target)}
      />
      <DuplicateHostAgentSheet
        record={duplicating}
        records={host.configs}
        duplicate={host.duplicate}
        onClose={() => setDuplicating(null)}
        onDuplicated={(created) => {
          setDuplicating(null)
          router.push(externalAgentDetailHref(created.configId))
        }}
      />
    </div>
  )
}

function DetailSkeleton() {
  const t = useTranslations("mobile.externalAgents")
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={t("loading")}
      className="flex flex-col gap-4"
      data-testid="host-agent-detail-loading"
    >
      <Skeleton className="h-24 w-full rounded-xl" />
      <Skeleton className="h-4 w-28" />
      <Skeleton className="h-11 w-full" />
      <Skeleton className="h-11 w-full" />
      <Skeleton className="h-32 w-full rounded-xl" />
    </div>
  )
}

function DetailHeader({
  record,
  records,
}: {
  record: ExternalAgentConfigRecord
  records: readonly ExternalAgentConfigRecord[]
}) {
  const t = useTranslations("mobile.externalAgents")
  const name = hostAgentName(record)
  const preset = presetOf(record)
  const ready = record.lifecycleStatus === "ready"
  const source = lineageSourceOf(record, records)
  return (
    <div className="flex flex-col gap-3">
      <div
        className="flex items-start gap-3 rounded-xl border bg-card p-3"
        data-testid="host-agent-detail-header"
      >
        {preset ? (
          <BrandIcon id={preset} size={40} label={name} />
        ) : (
          <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-md bg-muted">
            <BotIcon className="size-5 text-muted-foreground" aria-hidden />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-base font-semibold">{name}</p>
          <p className="truncate font-mono text-[11px] text-muted-foreground">
            {record.config.protocol} · {record.config.transport}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <HostAgentIsolationChip record={record} />
            {ready ? (
              <Badge variant="success" data-testid="host-agent-detail-ready">
                {t("statusReady")}
              </Badge>
            ) : null}
          </div>
          {source ? (
            <p
              className="mt-1.5 flex items-center gap-1 text-xs text-muted-foreground"
              data-testid="host-agent-detail-lineage"
            >
              <GitForkIcon className="size-3.5 shrink-0" aria-hidden />
              {source === "removed" ? (
                t("copiedFromRemoved")
              ) : (
                <Link
                  href={externalAgentDetailHref(source.configId)}
                  className="touch-hit truncate underline underline-offset-2"
                >
                  {t("copiedFrom", { name: hostAgentName(source) })}
                </Link>
              )}
            </p>
          ) : null}
        </div>
      </div>
      {!ready ? (
        <LifecycleStatusNotice
          status={record.lifecycleStatus}
          reasonCode={record.config.lifecycleReasonCode}
        />
      ) : null}
    </div>
  )
}

function HostAgentConfigForm({
  record,
  host,
  onSaveResult,
}: {
  record: ExternalAgentConfigRecord
  host: HostExternalAgentConfigsState
  onSaveResult: (ok: boolean) => void
}) {
  const t = useTranslations("mobile.externalAgents")
  const tManager = useTranslations("externalAgent.manager")
  const config = record.config as unknown as ExternalAgentConfig
  const [seed] = useState(() => addAgentFormFromConfig(config))
  const form = useAddAgentForm(seed.presetId, seed)
  const problemMessage = useAddAgentProblemMessage()
  const processPlane = useExternalAgentProcessPlane(PROCESS_PLANE_COMMANDS.spawn)
  const planeWarning = processPlane.ok
    ? null
    : tManager(`processPlaneWarning.${PLANE_WARNING_KEYS[processPlane.reason]}`)

  const [description, setDescription] = useState(config.description ?? "")
  const [enabled, setEnabled] = useState(record.enabled)
  const [requestedMode, setRequestedMode] = useState<AcpPermissionMode | undefined>(
    config.defaultPermissionMode
  )
  const permissionMode = effectivePermissionMode(requestedMode, form.data.protocol)
  const savedIsolation = stateIsolationOf(record)
  const [requestedIsolation, setRequestedIsolation] =
    useState<ExternalAgentStateIsolation>(savedIsolation)
  const { command: launchCommand, args: launchArgs } = addAgentFormLaunchTarget(form.data)
  const stateIsolation = effectiveStateIsolation(requestedIsolation, launchCommand, launchArgs)
  const [maxSessions, setMaxSessions] = useState(
    config.maxConcurrentSessions ? String(config.maxConcurrentSessions) : ""
  )
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const advancedRef = useRef<HTMLDivElement>(null)
  const notReady = record.lifecycleStatus !== "ready"
  const name = hostAgentName(record)

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (saving) return
    const prepared = form.prepare()
    if (!prepared.ok) {
      setProblem(problemMessage(prepared.problem))
      if (CONNECTION_PROBLEMS.has(prepared.problem)) {
        setAdvancedOpen(true)
        requestAnimationFrame(() =>
          advancedRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
        )
      }
      return
    }
    const limitText = maxSessions.trim()
    const limit = limitText ? Number(limitText) : null
    if (limit !== null && (!Number.isInteger(limit) || limit <= 0)) {
      setProblem(t("maxSessionsInvalid"))
      return
    }
    setProblem(null)
    setSaving(true)
    // `null` clears an optional field on the Host: a patch is JSON, and JSON
    // has no `undefined` (see `UpdateHostConfigInput`).
    const patch = {
      ...addAgentFormPatch(config, prepared.data),
      description: description.trim() || null,
      enabled,
      defaultPermissionMode: permissionMode,
      stateIsolation,
      maxConcurrentSessions: limit,
    } as unknown as Partial<StoredExternalAgentConfig>
    const ok = await host.update(record, patch)
    setSaving(false)
    onSaveResult(ok)
    if (ok) toast.success(t("saved"))
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col gap-5"
      noValidate
      aria-labelledby="host-agent-config-title"
      data-testid="host-agent-config-form"
    >
      <h2
        id="host-agent-config-title"
        className="px-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase"
      >
        {t("configurationTitle")}
      </h2>

      <div className="grid gap-4">
        <div className="grid gap-2">
          <Label htmlFor="detail-name">{tManager("name")}</Label>
          <Input
            id="detail-name"
            value={form.data.name}
            onChange={(event) => form.setField("name", event.target.value)}
            className="h-11"
            required
            data-testid="host-agent-detail-name"
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="detail-description">{t("descriptionLabel")}</Label>
          <Textarea
            id="detail-description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder={t("descriptionPlaceholder")}
            className="min-h-16 text-sm"
            data-testid="host-agent-detail-description"
          />
        </div>
        <div className="flex min-h-11 items-center justify-between gap-3">
          <div className="min-w-0 space-y-0.5">
            <Label htmlFor="detail-enabled" className="text-sm">
              {t("enabledLabel")}
            </Label>
            <p className="text-xs text-muted-foreground">{t("enabledHint")}</p>
          </div>
          <Switch
            id="detail-enabled"
            checked={enabled}
            // The Host keeps a configuration it cannot run switched off; the
            // notice above says why.
            disabled={notReady || saving}
            onCheckedChange={setEnabled}
            aria-label={t("enabledAria", { name })}
            className="touch-hit"
            data-testid="host-agent-detail-enabled"
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="detail-permission-mode">{t("permissionLabel")}</Label>
          <Select
            value={permissionMode}
            onValueChange={(value) => setRequestedMode(value as AcpPermissionMode)}
          >
            <SelectTrigger
              id="detail-permission-mode"
              className="h-11 w-full"
              aria-label={t("permissionModeAria", { name })}
              data-testid="host-agent-detail-permission"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {permissionModesFor(form.data.protocol).map((mode) => (
                <SelectItem key={mode} value={mode}>
                  {t(PERMISSION_MODE_LABEL_KEY[mode])}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <StateIsolationField
          value={stateIsolation}
          onChange={setRequestedIsolation}
          command={launchCommand}
          args={launchArgs}
          disabled={saving}
          showSignInWarning={savedIsolation === "shared"}
        />
        <div className="grid gap-2">
          <Label htmlFor="detail-max-sessions">{t("maxSessionsLabel")}</Label>
          <Input
            id="detail-max-sessions"
            type="number"
            inputMode="numeric"
            min={1}
            step={1}
            value={maxSessions}
            onChange={(event) => setMaxSessions(event.target.value)}
            className="h-11"
            aria-describedby="detail-max-sessions-hint"
            data-testid="host-agent-detail-max-sessions"
          />
          <p id="detail-max-sessions-hint" className="text-xs text-muted-foreground">
            {t("maxSessionsHint")}
          </p>
        </div>
      </div>

      <Collapsible
        open={advancedOpen}
        onOpenChange={setAdvancedOpen}
        className="rounded-xl border"
        data-testid="host-agent-detail-advanced"
      >
        <div ref={advancedRef} className="scroll-mt-16">
          <CollapsibleTrigger
            className="group flex min-h-11 w-full items-center justify-between gap-3 px-3 py-3 text-left"
            data-testid="host-agent-detail-advanced-trigger"
          >
            <span className="min-w-0">
              <span className="block text-sm font-medium">{t("advancedTitle")}</span>
              <span className="block text-xs text-muted-foreground">
                {t("advancedEditSummary")}
              </span>
            </span>
            <ChevronDownIcon
              className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180"
              aria-hidden
            />
          </CollapsibleTrigger>
        </div>
        <CollapsibleContent className="grid gap-5 border-t px-3 py-4">
          <ConnectionFields form={form} planeWarning={planeWarning} />
          <ExecutionTuningFields form={form} collapsible={false} />
          <AddAgentCogniaModelField form={form} />
        </CollapsibleContent>
      </Collapsible>

      {problem ? (
        <Alert variant="destructive" data-testid="host-agent-detail-problem">
          <AlertCircleIcon />
          <AlertDescription>{problem}</AlertDescription>
        </Alert>
      ) : null}

      {/* Sticky inside the page's scroller so it rides above the keyboard. */}
      <div className="sticky bottom-0 -mx-4 border-t bg-background/95 px-4 pt-3 pb-3 safe-area-pb backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <Button
          type="submit"
          className="h-11 w-full"
          disabled={saving || host.busy}
          data-testid="host-agent-detail-save"
        >
          {saving ? (
            <>
              <Spinner className="size-4" />
              {t("saving")}
            </>
          ) : (
            t("save")
          )}
        </Button>
      </div>
    </form>
  )
}

function SiblingList({
  record,
  siblings,
}: {
  record: ExternalAgentConfigRecord
  siblings: readonly ExternalAgentConfigRecord[]
}) {
  const t = useTranslations("mobile.externalAgents")

  const valueLabel = (difference: InstanceDifference): string => {
    const { key, value } = difference
    if (key === "permissionMode" && value) {
      const labelKey = PERMISSION_MODE_LABEL_KEY[value as AcpPermissionMode]
      return labelKey ? t(labelKey) : value
    }
    if (key === "stateIsolation") {
      return value === "isolated" ? t("isolationOwn") : t("isolationShared")
    }
    if (key === "sandbox") {
      return value && SANDBOX_LABEL_KEY[value] ? t(SANDBOX_LABEL_KEY[value]) : t("sandboxDefault")
    }
    if (key === "network") {
      return value === "on" ? t("networkOn") : value === "off" ? t("networkOff") : t("diffNone")
    }
    if (value === null) {
      if (key === "model") return t("modelNative")
      if (key === "account") return t("accountActive")
      if (key === "sessionLimit") return t("sessionLimitNone")
      return t("diffNone")
    }
    return value
  }

  return (
    <section className="flex flex-col gap-2" aria-labelledby="host-agent-siblings-title">
      <div className="px-1">
        <h2
          id="host-agent-siblings-title"
          className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase"
        >
          {t("siblingsTitle")}
        </h2>
        <p className="text-xs text-muted-foreground">{t("siblingsDescription")}</p>
      </div>
      <ul className="flex flex-col gap-2" data-testid="host-agent-siblings">
        {siblings.map((sibling) => {
          const differences = siblingDifferences(record, sibling)
          const siblingName = hostAgentName(sibling)
          return (
            <li key={sibling.configId}>
              <Link
                href={externalAgentDetailHref(sibling.configId)}
                className="flex min-h-11 items-center gap-3 rounded-xl border bg-card p-3 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 active:bg-muted/60"
                data-testid={`host-agent-sibling-${sibling.configId}`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{siblingName}</span>
                  <span className="mt-1 flex flex-wrap gap-1">
                    {differences.length === 0 ? (
                      <span className="text-xs text-muted-foreground">{t("siblingSame")}</span>
                    ) : (
                      differences.map((difference) => (
                        <Badge
                          key={difference.key}
                          variant="outline"
                          className="max-w-full truncate font-normal text-muted-foreground"
                        >
                          {t(DIFFERENCE_LABEL_KEY[difference.key], {
                            value: valueLabel(difference),
                          })}
                        </Badge>
                      ))
                    )}
                  </span>
                </span>
                <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              </Link>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
