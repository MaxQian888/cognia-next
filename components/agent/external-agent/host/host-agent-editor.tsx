"use client"

import { useRef, useState, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import { MoreHorizontal, RotateCwIcon } from "lucide-react"
import { toast } from "sonner"

import { AgentDetailHeader } from "@/components/agent/external-agent/detail/agent-detail-header"
import { AgentDetailStatus } from "@/components/agent/external-agent/detail/agent-detail-status"
import { FieldEditorDrawer } from "@/components/agent/external-agent/detail/field-editor-drawer"
import {
  AgentStateEditor,
  NameDescriptionEditor,
  NetworkEditor,
  PermissionModeEditor,
  ProcessEditor,
  SessionLimitEditor,
  TimeoutRetryEditor,
} from "@/components/agent/external-agent/detail/editors/agent-field-editors"
import { ConnectionFields } from "@/components/agent/external-agent/add-agent/connection-fields"
import { AddAgentCogniaModelField } from "@/components/agent/external-agent/add-agent/execution-tuning-fields"
import { LifecycleStatusNotice } from "@/components/agent/external-agent/lifecycle-status-notice"
import { MeRow } from "@/components/mobile/me/me-row"
import { MeSection } from "@/components/mobile/me/me-section"
import { DuplicateHostAgentSheet } from "@/components/mobile/external-agents/duplicate-host-agent-sheet"
import { RemoveHostAgentDialog } from "@/components/mobile/external-agents/remove-host-agent-dialog"
import { ExternalAgentScreenSkeleton } from "@/components/mobile/external-agents/external-agent-screen-skeleton"
import {
  hostAgentName,
  lineageSourceOf,
  presetOf,
  siblingDifferences,
  siblingsOf,
} from "@/components/mobile/external-agents/host-agent-family"
import {
  effectivePermissionMode,
  PERMISSION_MODE_LABEL_KEY,
} from "@/components/mobile/external-agents/permission-modes"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  useHostExternalAgentConfigs,
  type HostExternalAgentConfigsState,
} from "@/hooks/agent/use-host-external-agent-configs"
import { useAddAgentForm } from "@/hooks/agent/use-add-agent-form"
import { useAddAgentProblemMessage } from "@/hooks/agent/use-add-agent-problem-message"
import {
  addAgentFormFromConfig,
  addAgentFormPatch,
} from "@/lib/ai/agent/external/config/add-agent-form"
import { canUseCogniaModels } from "@/lib/ai/agent/external/config/gateway-task"
import { getReadinessRemedy } from "@/lib/ai/agent/external/readiness-remedy"
import {
  buildDraftUpdate,
  draftFromAgent,
  type ConnectionDraft,
  type DraftErrors,
} from "@/components/settings/agent/inspector-draft"
import type { LifecycleExternalAgentConfig } from "@/stores/agent/external-agent-store"
import type { StoredExternalAgentConfig } from "@/stores/agent/external-agent-store/types"
import type { ExternalAgentConfigRecord } from "@/types/agent/external-agent-config-store"
import type { AcpPermissionMode, ExternalAgentConfig } from "@/types/agent/external-agent"
import type { InstanceDifference } from "@/lib/ai/agent/external/config/instance-family"
import { HOST_UNAVAILABLE_KEY } from "./host-agent-create-form"

type Editor =
  | "name"
  | "command"
  | "arguments"
  | "cwd"
  | "endpoint"
  | "apiKey"
  | "permission"
  | "state"
  | "sessions"
  | "retry"
  | "connection"
  | "model"
const EDITOR_FIELDS: Partial<Record<Editor, readonly (keyof ConnectionDraft)[]>> = {
  name: ["name", "description"],
  command: ["processCommand"],
  arguments: ["processArgs"],
  cwd: ["processCwd"],
  endpoint: ["networkEndpoint"],
  apiKey: ["networkApiKey"],
  state: ["stateIsolation"],
  sessions: ["sessionLimit", "sessionIdleTimeout"],
  retry: [
    "timeoutMs",
    "retryMaxRetries",
    "retryDelayMs",
    "retryMaxDelayMs",
    "retryExponentialBackoff",
  ],
}
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

export interface HostAgentEditorProps {
  configId: string
  onRemoved: () => void
  onDuplicated: (newConfigId: string) => void
  onSaved?: () => void
  /** Optional surface navigation; without it siblings open inside this editor. */
  onOpenConfig?: (configId: string) => void
}

function configOf(record: ExternalAgentConfigRecord): LifecycleExternalAgentConfig {
  return {
    ...record.config,
    id: record.configId,
    enabled: record.enabled,
  } as unknown as LifecycleExternalAgentConfig
}

export function HostAgentEditor(props: HostAgentEditorProps) {
  return <HostEditorSelection key={props.configId} {...props} />
}

function HostEditorSelection(props: HostAgentEditorProps) {
  const t = useTranslations("mobile.externalAgents")
  const tHost = useTranslations("externalAgent.hostConfigs")
  const host = useHostExternalAgentConfigs()
  const [selectedId, setSelectedId] = useState(props.configId)
  const record = host.configs.find((row) => row.configId === selectedId)
  const openConfig = (id: string) => {
    if (props.onOpenConfig) props.onOpenConfig(id)
    else setSelectedId(id)
  }
  if (host.unavailable)
    return (
      <Empty data-testid="host-agent-detail-unavailable">
        <EmptyHeader>
          <EmptyTitle>{tHost("unavailableTitle")}</EmptyTitle>
          <EmptyDescription>{tHost(HOST_UNAVAILABLE_KEY[host.unavailable])}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  if (!record) {
    if (host.loading)
      return (
        <div data-testid="host-agent-detail-loading" aria-busy="true">
          <ExternalAgentScreenSkeleton />
        </div>
      )
    const failed = host.error !== null && host.configs.length === 0
    return (
      <Empty data-testid={failed ? "host-agent-detail-load-failed" : "host-agent-detail-not-found"}>
        <EmptyHeader>
          <EmptyTitle>{t(failed ? "loadFailedTitle" : "detailNotFoundTitle")}</EmptyTitle>
          <EmptyDescription className="break-words">
            {failed ? t("loadFailed", { message: host.error ?? "" }) : t("detailNotFoundBody")}
          </EmptyDescription>
        </EmptyHeader>
        <Button
          variant="outline"
          className="min-h-11"
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
    <HostEditorContent
      key={record.configId}
      {...props}
      record={record}
      host={host}
      onOpenConfig={openConfig}
    />
  )
}

function HostEditorContent({
  record,
  host,
  onRemoved,
  onDuplicated,
  onSaved,
  onOpenConfig,
}: HostAgentEditorProps & {
  record: ExternalAgentConfigRecord
  host: HostExternalAgentConfigsState
  onOpenConfig: (id: string) => void
}) {
  const t = useTranslations("mobile.externalAgents")
  const ts = useTranslations("externalAgent.settings")
  const tState = useTranslations("externalAgent.stateIsolationField")
  const tModel = useTranslations("externalAgent.cogniaModel")
  const tManage = useTranslations("externalAgentManage.editor")
  const [editing, setEditing] = useState<{
    item: Editor
    opened: ExternalAgentConfigRecord
  } | null>(null)
  const [pendingRemoval, setPendingRemoval] = useState<ExternalAgentConfigRecord | null>(null)
  const [duplicating, setDuplicating] = useState<ExternalAgentConfigRecord | null>(null)
  const [writeFailed, setWriteFailed] = useState(false)
  const config = configOf(record)
  const saved = draftFromAgent(config)
  const name = hostAgentName(record)
  const source = lineageSourceOf(record, host.configs)
  const siblings = siblingsOf(record, host.configs)
  const preset = presetOf(record)
  const ready = record.lifecycleStatus === "ready"
  const spawns = config.transport === "stdio" || config.metadata?.autoSpawnServer === true
  const open = (item: Editor) => setEditing({ item, opened: record })
  const enabled = async (value: boolean) => {
    const ok = await host.update(record, { enabled: value })
    setWriteFailed(!ok)
    if (ok) onSaved?.()
  }
  const titles: Record<Editor, string> = {
    name: ts("mobileDetailNameDescription"),
    command: ts("command"),
    arguments: ts("arguments"),
    cwd: ts("workingDirectory"),
    endpoint: ts("endpoint"),
    apiKey: ts("apiKey"),
    permission: ts("mobileDetailPermissionMode"),
    state: tState("legend"),
    sessions: ts("mobileDetailSessionLimit"),
    retry: ts("sectionRetry"),
    connection: t("connectionOptions"),
    model: tModel("model"),
  }
  const row = (item: Editor, value: string) => (
    <MeRow
      key={item}
      label={titles[item]}
      onClick={() => open(item)}
      className="min-h-11 [&_[data-slot=item-actions]]:min-w-0 [&_[data-slot=item-actions]]:max-w-1/2 [&_[data-slot=item-actions]>span]:min-w-0"
      value={
        <span className="block max-w-full truncate" title={value}>
          {value || ts("mobileDetailNotSet")}
        </span>
      }
    />
  )
  const readOnly = (label: string, value: string) => (
    <MeRow
      label={label}
      description={t("changeOnHost")}
      value={
        <span className="block max-w-28 truncate" title={value}>
          {value}
        </span>
      }
      className="min-h-11"
    />
  )
  const remedy = getReadinessRemedy(record.config.lifecycleReasonCode, ready ? "off" : "blocked")
  let remedyItem: Editor | null = null
  let remedyLabel = ""
  if (remedy === "use-shared-state") {
    remedyItem = "state"
    remedyLabel = ts("remedies.use-shared-state")
  }
  if (remedy === "edit-session-limit") {
    remedyItem = "sessions"
    remedyLabel = ts("remedies.edit-session-limit")
  }
  if (remedy === "edit-credentials" && config.transport !== "stdio") {
    remedyItem = config.protocol === "opencode" ? "connection" : "apiKey"
    remedyLabel = ts("remedies.edit-credentials")
  }
  if (remedy === "edit-credentials" && config.metadata?.requiresManagedRuntime === true) {
    remedyItem = "connection"
    remedyLabel = ts("remedies.edit-credentials")
  }
  const hint =
    remedy === "open-runtimes"
      ? "hostRuntimeRemedy"
      : remedy === "open-plugins"
        ? "hostPluginRemedy"
        : remedy === "consent"
          ? "hostConsentRemedy"
          : remedy === "edit-credentials"
            ? "hostCredentialsRemedy"
            : "changeOnHost"
  const differenceValue = ({ key, value }: InstanceDifference) => {
    if (key === "permissionMode" && value)
      return t(PERMISSION_MODE_LABEL_KEY[value as AcpPermissionMode])
    if (key === "stateIsolation")
      return t(value === "isolated" ? "isolationOwn" : "isolationShared")
    if (key === "sandbox")
      return t(value && SANDBOX_LABEL_KEY[value] ? SANDBOX_LABEL_KEY[value] : "sandboxDefault")
    if (key === "network")
      return t(value === "on" ? "networkOn" : value === "off" ? "networkOff" : "diffNone")
    return (
      value ??
      t(
        key === "model"
          ? "modelNative"
          : key === "account"
            ? "accountActive"
            : key === "sessionLimit"
              ? "sessionLimitNone"
              : "diffNone"
      )
    )
  }
  const remove = async (target: ExternalAgentConfigRecord) => {
    setPendingRemoval(null)
    const ok = await host.remove(target)
    setWriteFailed(!ok)
    if (ok) {
      toast.success(t("removed", { name: hostAgentName(target) }))
      onRemoved()
    }
  }
  return (
    <div
      className="@container min-w-0 space-y-5 [&_[data-testid=duplicated-from-hint]]:min-h-11"
      data-testid="host-agent-detail"
    >
      <AgentDetailHeader
        name={name}
        protocol={config.protocol}
        transport={config.transport}
        stateIsolation={config.stateIsolation}
        presetId={preset}
        headingId={`host-agent-${record.configId}`}
        sourceName={source && source !== "removed" ? hostAgentName(source) : null}
        onOpenSource={
          source && source !== "removed" ? () => onOpenConfig(source.configId) : undefined
        }
        menu={
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="min-h-11 min-w-11"
                aria-label={t("moreActionsAria", { name })}
              >
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem disabled={host.busy} onSelect={() => setDuplicating(record)}>
                {t("duplicate")}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={host.busy}
                variant="destructive"
                onSelect={() => setPendingRemoval(record)}
              >
                {t("deleteConfirm")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        }
      />
      {source === "removed" ? (
        <p className="text-xs text-muted-foreground">{t("copiedFromRemoved")}</p>
      ) : null}
      {!ready ? (
        <LifecycleStatusNotice
          status={record.lifecycleStatus}
          reasonCode={config.lifecycleReasonCode}
          className="[&>div:last-child]:w-full"
          action={
            remedyItem ? (
              <Button
                className="min-h-11 w-full whitespace-normal"
                onClick={() => {
                  if (remedyItem) open(remedyItem)
                }}
              >
                {remedyLabel}
              </Button>
            ) : (
              <p className="text-xs">{t(hint)}</p>
            )
          }
        />
      ) : (
        <AgentDetailStatus
          tone={record.enabled ? "ok" : "info"}
          title={t(record.enabled ? "hostEnabledStatus" : "hostDisabledStatus")}
          action={
            !record.enabled
              ? { label: t("enabledLabel"), onRun: () => void enabled(true), busy: host.busy }
              : undefined
          }
        />
      )}
      {writeFailed && host.error ? (
        <p role="alert" className="break-words text-sm text-destructive">
          {t("saveFailed", { message: host.error })}
        </p>
      ) : null}
      <MeSection title={ts("mobileDetailGeneral")} withSeparators>
        <MeRow
          label={t("enabledLabel")}
          value={
            <Switch
              className="touch-hit"
              checked={record.enabled}
              disabled={!ready || host.busy}
              aria-label={t("enabledAria", { name })}
              onCheckedChange={(value) => void enabled(value)}
            />
          }
        />
        {row("name", [name, config.description].filter(Boolean).join(" · "))}
      </MeSection>
      <MeSection title={ts("sectionConnection")} withSeparators>
        {spawns && config.metadata?.requiresManagedRuntime !== true
          ? [
              row("command", saved.processCommand),
              row("arguments", saved.processArgs),
              row("cwd", saved.processCwd),
            ]
          : config.transport !== "stdio" && config.protocol !== "opencode-v2"
            ? [
                row("endpoint", saved.networkEndpoint),
                row(
                  "apiKey",
                  config.credentialRefs?.apiKey || config.network?.apiKey
                    ? ts("mobileDetailSaved")
                    : ""
                ),
              ]
            : null}
        {row("connection", `${config.protocol} · ${config.transport}`)}
      </MeSection>
      <MeSection title={ts("mobileDetailBehaviour")} withSeparators>
        {row(
          "permission",
          t(
            PERMISSION_MODE_LABEL_KEY[
              effectivePermissionMode(config.defaultPermissionMode, config.protocol)
            ]
          )
        )}
        {spawns
          ? row(
              "state",
              t(config.stateIsolation === "isolated" ? "isolationOwn" : "isolationShared")
            )
          : null}
        {row(
          "sessions",
          config.maxConcurrentSessions
            ? String(config.maxConcurrentSessions)
            : t("sessionLimitNone")
        )}
        {row(
          "retry",
          ts("sectionRetrySummary", {
            timeout: (config.timeout ?? 300000) / 1000,
            retries: config.retryConfig?.maxRetries ?? 3,
          })
        )}
        {row("model", config.cogniaModel?.modelId ?? t("modelNative"))}
        {preset === "codex" || config.protocol === "codex-app-server"
          ? readOnly(
              ts("codexSandboxMode"),
              t(SANDBOX_LABEL_KEY[config.codexOptions?.sandboxMode ?? ""] ?? "sandboxDefault")
            )
          : null}
        {readOnly(tManage("autoApprove"), config.autoApprovePatterns?.join(", ") || t("diffNone"))}
        {readOnly(
          tManage("requireApprovalFor"),
          config.requireApprovalFor?.join(", ") || t("diffNone")
        )}
        {config.protocol === "pi-rpc"
          ? readOnly(
              t("piPackages"),
              Array.isArray(config.metadata?.piPackages)
                ? config.metadata.piPackages.join(", ")
                : t("diffNone")
            )
          : null}
        {preset === "codex" ||
        config.protocol === "codex-app-server" ||
        config.subscriptionAccountId
          ? readOnly(t("subscriptionAccount"), config.subscriptionAccountId ?? t("accountActive"))
          : null}
      </MeSection>
      {siblings.length ? (
        <MeSection
          title={t("siblingsTitle")}
          description={t("siblingsDescription")}
          withSeparators
          testid="host-agent-siblings"
        >
          {siblings.map((sibling) => {
            const differences = siblingDifferences(record, sibling)
            return (
              <MeRow
                key={sibling.configId}
                label={hostAgentName(sibling)}
                onClick={() => onOpenConfig(sibling.configId)}
                className="min-h-11"
                testid={`host-agent-sibling-${sibling.configId}`}
                description={
                  differences.length
                    ? differences
                        .map((difference) =>
                          t(DIFFERENCE_LABEL_KEY[difference.key], {
                            value: differenceValue(difference),
                          })
                        )
                        .join(" · ")
                    : t("siblingSame")
                }
              />
            )
          })}
        </MeSection>
      ) : null}
      <MeSection title={ts("mobileDetailManage")} withSeparators>
        <MeRow
          label={t("duplicate")}
          ariaLabel={t("duplicateAria", { name })}
          className="min-h-11"
          disabled={host.busy}
          onClick={() => setDuplicating(record)}
          testid="host-agent-detail-duplicate"
        />
        <MeRow
          label={t("deleteConfirm")}
          ariaLabel={t("removeAria", { name })}
          className="min-h-11"
          disabled={host.busy}
          destructive
          onClick={() => setPendingRemoval(record)}
          testid="host-agent-detail-remove"
        />
      </MeSection>
      {editing ? (
        <HostFieldDrawer
          key={`${editing.item}-${editing.opened.revision}`}
          item={editing.item}
          title={titles[editing.item]}
          opened={editing.opened}
          latest={record}
          host={host}
          onClose={() => setEditing(null)}
          onReload={() => setEditing({ ...editing, opened: record })}
          onSaved={onSaved}
        />
      ) : null}
      <RemoveHostAgentDialog
        record={pendingRemoval}
        onCancel={() => setPendingRemoval(null)}
        onConfirm={(target) => void remove(target)}
      />
      <DuplicateHostAgentSheet
        record={duplicating}
        records={host.configs}
        duplicate={host.duplicate}
        onClose={() => setDuplicating(null)}
        onDuplicated={(created) => {
          setDuplicating(null)
          onDuplicated(created.configId)
        }}
      />
    </div>
  )
}

/** Draft lifetime follows the opened item, never the Host's refreshed revision. */
function HostFieldDrawer({
  item,
  title,
  opened,
  latest,
  host,
  onClose,
  onReload,
  onSaved,
}: {
  item: Editor
  title: string
  opened: ExternalAgentConfigRecord
  latest: ExternalAgentConfigRecord
  host: HostExternalAgentConfigsState
  onClose: () => void
  onReload: () => void
  onSaved?: () => void
}) {
  const t = useTranslations("mobile.externalAgents")
  const ts = useTranslations("externalAgent.settings")
  const tManage = useTranslations("externalAgentManage.editor")
  const [draft, setDraft] = useState(() => draftFromAgent(configOf(opened)))
  const [permission, setPermission] = useState(() =>
    effectivePermissionMode(opened.config.defaultPermissionMode, opened.config.protocol)
  )
  const [retryOnErrors, setRetryOnErrors] = useState(() =>
    (opened.config.retryConfig?.retryOnErrors ?? []).join("\n")
  )
  const [errors, setErrors] = useState<DraftErrors>({})
  const [problem, setProblem] = useState<string | null>(null)
  const [refused, setRefused] = useState(false)
  const overwrite = useRef(false)
  const seed = addAgentFormFromConfig(configOf(opened) as ExternalAgentConfig)
  const form = useAddAgentForm(seed.presetId, seed)
  const problemMessage = useAddAgentProblemMessage()
  const conflict =
    refused && Boolean(host.error && /moved to revision|config_conflict/i.test(host.error))
  const onChange = <K extends keyof ConnectionDraft>(key: K, value: ConnectionDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }))
    setErrors((current) => ({ ...current, [key]: undefined }))
  }
  const save = async () => {
    const target = overwrite.current ? latest : opened
    overwrite.current = false
    const config = configOf(target)
    const result = buildDraftUpdate(
      config,
      draft,
      draftFromAgent(config),
      EDITOR_FIELDS[item] ?? []
    )
    setErrors(result.errors)
    if (Object.keys(result.errors).length) return false
    let patch: Partial<StoredExternalAgentConfig> =
      result.updates as Partial<StoredExternalAgentConfig>
    if (result.updates.description === "")
      patch = { ...patch, description: null } as unknown as Partial<StoredExternalAgentConfig>
    if (item === "permission")
      patch.defaultPermissionMode = effectivePermissionMode(permission, config.protocol)
    if (item === "retry")
      patch.retryConfig = {
        ...config.retryConfig,
        maxRetries: Number(draft.retryMaxRetries),
        retryDelay: Number(draft.retryDelayMs),
        maxRetryDelay: Number(draft.retryMaxDelayMs),
        exponentialBackoff: draft.retryExponentialBackoff,
        retryOnErrors: retryOnErrors
          .split(/\r?\n|,/)
          .map((line) => line.trim())
          .filter(Boolean),
      }
    if (item === "model") {
      const binding = form.data.cogniaModel
      if (binding && (!binding.providerId || !binding.modelId || !canUseCogniaModels(config))) {
        setProblem(problemMessage("cogniaModelInvalid"))
        return false
      }
      patch.cogniaModel = binding ?? null
    }
    if (item === "connection") {
      const prepared = form.prepare()
      if (!prepared.ok) {
        setProblem(problemMessage(prepared.problem))
        return false
      }
      const connection = addAgentFormPatch(config as ExternalAgentConfig, prepared.data)
      patch = {
        protocol: connection.protocol,
        transport: connection.transport,
        metadata: connection.metadata,
        ...(connection.process ? { process: connection.process } : {}),
        ...(connection.network ? { network: connection.network } : {}),
        defaultPermissionMode: effectivePermissionMode(
          config.defaultPermissionMode,
          prepared.data.protocol
        ),
      } as Partial<StoredExternalAgentConfig>
    }
    setProblem(null)
    const ok = await host.update(target, patch)
    setRefused(!ok)
    if (ok) {
      toast.success(t("saved"))
      onSaved?.()
    }
    return ok
  }
  const fieldProps = { draft, onChange, errors }
  const editors: Record<Editor, ReactNode> = {
    name: <NameDescriptionEditor {...fieldProps} />,
    command: <ProcessEditor {...fieldProps} field="processCommand" />,
    arguments: <ProcessEditor {...fieldProps} field="processArgs" />,
    cwd: <ProcessEditor {...fieldProps} field="processCwd" allowLocalBrowse={false} />,
    endpoint: <NetworkEditor {...fieldProps} field="networkEndpoint" />,
    apiKey: (
      <NetworkEditor
        {...fieldProps}
        field="networkApiKey"
        hasSavedApiKey={Boolean(opened.config.credentialRefs?.apiKey)}
      />
    ),
    permission: (
      <PermissionModeEditor
        protocol={opened.config.protocol}
        value={permission}
        onChange={setPermission}
      />
    ),
    state: (
      <AgentStateEditor
        value={draft.stateIsolation}
        onChange={(value) => onChange("stateIsolation", value)}
        command={opened.config.process?.command}
        args={opened.config.process?.args}
        showSignInWarning={opened.config.stateIsolation !== "isolated"}
      />
    ),
    sessions: <SessionLimitEditor {...fieldProps} />,
    retry: (
      <>
        <TimeoutRetryEditor {...fieldProps} />
        <div className="grid gap-2">
          <Label htmlFor="host-retry-errors">{ts("retryErrorPatterns")}</Label>
          <Textarea
            id="host-retry-errors"
            value={retryOnErrors}
            onChange={(event) => setRetryOnErrors(event.target.value)}
          />
        </div>
      </>
    ),
    connection: <ConnectionFields form={form} planeWarning={null} />,
    model: <AddAgentCogniaModelField form={form} />,
  }
  return (
    <FieldEditorDrawer
      open
      title={title}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      onSave={save}
      testid="host-agent-field-editor"
    >
      <div className="@container space-y-4 [&_input]:min-h-11 [&_button[role=combobox]]:min-h-11 [&_.sm\:grid-cols-2]:grid-cols-1 @sm:[&_.sm\:grid-cols-2]:grid-cols-2">
        {editors[item]}
      </div>
      {Object.entries(errors)
        .filter(([field]) => !EDITOR_FIELDS[item]?.includes(field as keyof ConnectionDraft))
        .map(([field, key]) =>
          key ? (
            <p key={field} role="alert" className="text-sm text-destructive">
              {key === "invalidIdleTimeout" ? tManage(key) : ts(key)}
            </p>
          ) : null
        )}
      {problem ? (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      ) : null}
      {refused && host.error ? (
        <div role="alert" className="space-y-3 text-sm">
          <p className="break-words text-destructive">
            {conflict ? t("saveConflict") : t("saveFailed", { message: host.error })}
          </p>
          {conflict ? (
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                className="min-h-11 whitespace-normal"
                onClick={onReload}
              >
                {t("reloadTheirs")}
              </Button>
              <Button
                type="submit"
                className="min-h-11 whitespace-normal"
                onClick={() => {
                  overwrite.current = true
                }}
              >
                {t("overwriteMine")}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </FieldEditorDrawer>
  )
}
