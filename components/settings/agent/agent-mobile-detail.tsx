"use client"

import { isCodexAppServerProtocol } from "@/lib/ai/agent/external/protocol-options"

import { useState, type ComponentProps, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import { MoreHorizontal } from "lucide-react"

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
  WebSearchEditor,
} from "@/components/agent/external-agent/detail/editors/agent-field-editors"
import { UnsandboxedConsentAction } from "@/components/agent/external-agent/unsandboxed-consent-action"
import { MeRow } from "@/components/mobile/me/me-row"
import { MeSection } from "@/components/mobile/me/me-section"
import { ResponsiveFormDialog } from "@/components/shared/responsive-form-dialog"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { toast } from "@/components/ui/sonner"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { failureLines } from "@/lib/ai/agent/external/agent-failure"
import { isFromPreset } from "@/lib/ai/agent/external/config/presets"
import {
  lifecycleErrorKey,
  lifecycleErrorMessage,
} from "@/lib/ai/agent/external/lifecycle/error-messages"
import { getExternalAgentLifecycleService } from "@/lib/ai/agent/external/lifecycle/service"
import { adaptPermissionMode } from "@/lib/ai/agent/external/policy/permission-modes"
import { getReadinessRemedy } from "@/lib/ai/agent/external/readiness-remedy"
import { useExternalAgentStore } from "@/stores/agent/external-agent-store"
import type { AcpPermissionMode, UpdateExternalAgentInput } from "@/types/agent/external-agent"
import type { AgentInspector } from "./agent-inspector"
import { declaredWebSearchOf, PERMISSION_MODE_LABEL_KEY } from "./agent-editor-dialog"
import { AgentReadinessPipeline } from "./agent-readiness-pipeline"
import { CodexAppServerStatusCard } from "./codex-app-server-status-card"
import { OpencodeStatusCard } from "./opencode-status-card"
import { PiAuthStatusCard } from "./pi-auth-status-card"
import { KimiManagementCard } from "./kimi-management-card"
import {
  buildDraftUpdate,
  draftFromAgent,
  rebaseDraft,
  type ConnectionDraft,
  type DraftErrors,
} from "./inspector-draft"

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
  | "webSearch"
type Diagnostic = "codex" | "opencode" | "pi" | "kimi"

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

export function AgentMobileDetail(props: ComponentProps<typeof AgentInspector>) {
  // Changing selection discards the old drawer, including any pending draft.
  return <MobileDetail key={props.agent.id} {...props} />
}

function MobileDetail({
  agent,
  allAgents,
  readiness,
  isConnecting,
  onConnect,
  onDisconnect,
  onEdit,
  onDuplicate,
  onDelete,
  onAddRule,
  onOpenAgent,
  onOpenRuntimes,
  onOpenPlugins,
}: ComponentProps<typeof AgentInspector>) {
  const t = useTranslations("externalAgent.settings")
  const tCommon = useTranslations("common")
  const tReadiness = useTranslations("externalAgent.readiness")
  const tErrors = useTranslations("externalAgent.lifecycleErrors")
  const tLifecycle = useTranslations("externalAgent.lifecycle")
  const tManage = useTranslations("externalAgentManage.editor")
  const tFailure = useTranslations("externalAgent.failure")
  const tState = useTranslations("externalAgent.stateIsolationField")
  const tInstance = useTranslations("externalAgent.instanceSection")
  const failure = useExternalAgentStore((state) => state.agentFailures[agent.id])
  const clearFailure = useExternalAgentStore((state) => state.clearAgentFailure)
  const [editor, setEditor] = useState<Editor | null>(null)
  const [diagnostic, setDiagnostic] = useState<Diagnostic | null>(null)
  const [draft, setDraft] = useState(() => draftFromAgent(agent))
  const [baseline, setBaseline] = useState(() => draftFromAgent(agent))
  const [errors, setErrors] = useState<DraftErrors>({})
  const [saveError, setSaveError] = useState<string | null>(null)
  const [updatingEnabled, setUpdatingEnabled] = useState(false)
  const permission = adaptPermissionMode(
    agent.defaultPermissionMode ?? "default",
    agent.protocol
  ).mode
  const [draftPermission, setDraftPermission] = useState<AcpPermissionMode>(permission)
  const webSearch = declaredWebSearchOf(agent.declaredCapabilities) || "auto"
  const [draftWebSearch, setDraftWebSearch] = useState<"auto" | "native" | "unsupported">(webSearch)
  const connected = readiness.state === "connected"
  const presetId = isFromPreset(agent)
  const source = allAgents.find((other) => other.id === agent.duplicatedFromAgentId)

  const openEditor = (next: Editor) => {
    const initial = draftFromAgent(agent)
    setDraft(initial)
    setBaseline(initial)
    setDraftPermission(permission)
    setDraftWebSearch(webSearch)
    setErrors({})
    setSaveError(null)
    setEditor(next)
  }
  const onChange = <K extends keyof ConnectionDraft>(key: K, value: ConnectionDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }))
    setErrors((current) => ({ ...current, [key]: undefined }))
    setSaveError(null)
  }
  const update = async (updates: UpdateExternalAgentInput) => {
    const lifecycle = await getExternalAgentLifecycleService()
    await lifecycle.updateConfig(agent.id, updates)
  }
  const enable = async (enabled: boolean) => {
    setUpdatingEnabled(true)
    try {
      await update({ enabled })
    } catch (error) {
      toast.error(lifecycleErrorMessage(error, tErrors))
    } finally {
      setUpdatingEnabled(false)
    }
  }
  const save = async () => {
    if (!editor) return false
    const result = buildDraftUpdate(
      agent,
      rebaseDraft(draft, baseline, draftFromAgent(agent)),
      draftFromAgent(agent),
      EDITOR_FIELDS[editor] ?? []
    )
    setErrors(result.errors)
    if (Object.keys(result.errors).length) return false
    const updates = result.updates
    if (editor === "permission")
      updates.defaultPermissionMode = adaptPermissionMode(draftPermission, agent.protocol).mode
    if (editor === "webSearch") {
      const caps = { ...(agent.declaredCapabilities ?? {}) }
      if (draftWebSearch === "auto") delete caps["web.search"]
      else caps["web.search"] = draftWebSearch
      updates.declaredCapabilities = caps
    }
    try {
      await update(updates)
      toast.success(t("agentUpdated"))
      return true
    } catch (error) {
      setSaveError(lifecycleErrorMessage(error, tErrors))
      return false
    }
  }

  const titles: Record<Editor, string> = {
    name: t("mobileDetailNameDescription"),
    command: t("command"),
    arguments: t("arguments"),
    cwd: t("workingDirectory"),
    endpoint: t("endpoint"),
    apiKey: t("apiKey"),
    permission: t("mobileDetailPermissionMode"),
    state: tState("legend"),
    sessions: t("mobileDetailSessionLimit"),
    retry: t("sectionRetry"),
    webSearch: t("mobileDetailWebSearch"),
  }
  const diagnosticTitles: Record<Diagnostic, string> = {
    codex: t("codexAppServer.title"),
    opencode: t("mobileDetailOpenCode"),
    pi: t("mobileDetailPiSignIn"),
    kimi: t("mobileDetailKimi"),
  }
  const fieldProps = { draft, onChange, errors }
  const editors: Record<Editor, ReactNode> = {
    name: <NameDescriptionEditor {...fieldProps} />,
    command: <ProcessEditor {...fieldProps} field="processCommand" />,
    arguments: <ProcessEditor {...fieldProps} field="processArgs" />,
    cwd: <ProcessEditor {...fieldProps} field="processCwd" />,
    endpoint: (
      <NetworkEditor
        {...fieldProps}
        field="networkEndpoint"
        hasSavedApiKey={Boolean(agent.credentialRefs?.apiKey)}
      />
    ),
    apiKey: (
      <NetworkEditor
        {...fieldProps}
        field="networkApiKey"
        hasSavedApiKey={Boolean(agent.credentialRefs?.apiKey)}
      />
    ),
    permission: (
      <PermissionModeEditor
        protocol={agent.protocol}
        value={draftPermission}
        onChange={setDraftPermission}
      />
    ),
    state: (
      <AgentStateEditor
        value={draft.stateIsolation}
        onChange={(value) => onChange("stateIsolation", value)}
        command={agent.process?.command}
        args={agent.process?.args}
        showSignInWarning={agent.stateIsolation !== "isolated"}
      />
    ),
    sessions: <SessionLimitEditor {...fieldProps} />,
    retry: <TimeoutRetryEditor {...fieldProps} />,
    webSearch: <WebSearchEditor value={draftWebSearch} onChange={setDraftWebSearch} />,
  }
  const row = (item: Editor, value: string) => (
    <MeRow
      key={item}
      label={titles[item]}
      onClick={() => openEditor(item)}
      className="[&_[data-slot=item-actions]]:min-w-0 [&_[data-slot=item-actions]]:max-w-1/2 [&_[data-slot=item-actions]>span]:min-w-0"
      value={
        <span className="block max-w-full truncate" title={value}>
          {value || t("mobileDetailNotSet")}
        </span>
      }
    />
  )

  let status: ComponentProps<typeof AgentDetailStatus> = {
    tone: connected
      ? "ok"
      : readiness.state === "error"
        ? "error"
        : readiness.state === "blocked"
          ? "warning"
          : "info",
    title: tReadiness(`states.${readiness.blockTransient ? "checking" : readiness.state}`),
    message: readiness.blockReason ?? undefined,
    details: <AgentReadinessPipeline readiness={readiness} />,
    detailsLabel: t("mobileDetailReadinessSteps"),
  }
  const connectAction = (retry: boolean) => ({
    label: tReadiness(retry ? "actions.retry" : "actions.connect"),
    onRun: onConnect,
    busy: isConnecting,
    disabled: readiness.state === "disabled" || readiness.state === "blocked",
  })
  const hasVerdict = Boolean(agent.lifecycleStatus && agent.lifecycleStatus !== "ready")
  if (hasVerdict) {
    status.tone = "warning"
    status.title = agent.lifecycleReasonCode
      ? tErrors(lifecycleErrorKey(agent.lifecycleReasonCode))
      : tLifecycle("noReason")
    status.message = undefined
    const remedy = getReadinessRemedy(agent.lifecycleReasonCode, readiness.state)
    const remedies = {
      "open-runtimes": onOpenRuntimes,
      "edit-credentials": onEdit,
      "open-plugins": onOpenPlugins,
      "use-shared-state": () => {
        openEditor("state")
        setDraft((current) => ({ ...current, stateIsolation: "shared" }))
      },
      "edit-session-limit": () => openEditor("sessions"),
      enable: () => void enable(true),
    }
    if (remedy === "consent") {
      status.actionContent = (
        <div className="[&>button]:min-h-11 [&>button]:w-full">
          <UnsandboxedConsentAction agent={agent} />
        </div>
      )
    } else if (remedy === "connect" || remedy === "retry")
      status.action = connectAction(remedy === "retry")
    else if (remedy)
      status.action = {
        label: remedy === "enable" ? tReadiness("actions.enable") : t(`remedies.${remedy}`),
        onRun: remedies[remedy],
        href: remedy === "open-plugins" ? "/plugins" : undefined,
        busy: remedy === "enable" && updatingEnabled,
      }
  } else if (failure) {
    status = {
      ...status,
      tone: "error",
      title: tFailure(failure.phase),
      message: failure.message,
      action: connectAction(true),
      secondary: { label: tCommon("dismiss"), onRun: () => clearFailure(agent.id) },
      detailsLabel: t("mobileDetailShowDetails"),
      details: (
        <div className="space-y-3">
          <ul className="space-y-1 text-sm [overflow-wrap:anywhere]">
            {failureLines(failure)
              .slice(1)
              .map((line, index) => (
                <li key={index}>{line}</li>
              ))}
          </ul>
          <AgentReadinessPipeline readiness={readiness} />
        </div>
      ),
    }
  } else if (readiness.state === "disabled") {
    status.action = {
      label: tReadiness("actions.enable"),
      onRun: () => void enable(true),
      busy: updatingEnabled,
    }
  } else if (connected) {
    if (readiness.nextAction === "add-rule") {
      status.action = { label: t("disconnect"), onRun: onDisconnect }
      status.secondary = { label: tReadiness("actions.addRule"), onRun: onAddRule }
    } else status.secondary = { label: t("disconnect"), onRun: onDisconnect }
  } else if (isConnecting || readiness.state === "connecting") {
    status.title = tReadiness("states.connecting")
    status.action = { label: tReadiness("states.connecting"), busy: true }
  } else if (readiness.state === "off" || readiness.state === "error")
    status.action = connectAction(readiness.state === "error")

  const diagnostics: Diagnostic[] = []
  if (isCodexAppServerProtocol(agent.protocol)) diagnostics.push("codex")
  if (agent.protocol === "opencode" || agent.protocol === "opencode-v2")
    diagnostics.push("opencode")
  if (agent.protocol === "pi-rpc") diagnostics.push("pi")
  if (presetId === "kimi" && agent.protocol === "acp") diagnostics.push("kimi")
  const saved = draftFromAgent(agent)

  return (
    <div className="min-w-0 space-y-5" data-testid={`agent-mobile-detail-${agent.id}`}>
      <AgentDetailHeader
        name={agent.name}
        protocol={agent.protocol}
        transport={agent.transport}
        stateIsolation={agent.stateIsolation}
        presetId={presetId}
        headingId={`agent-${agent.id}`}
        sourceName={source?.name}
        onOpenSource={source ? () => onOpenAgent(source.id) : undefined}
        menu={
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="min-h-11 min-w-11"
                aria-label={t("mobileDetailMoreOptions")}
              >
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={onEdit}>{t("mobileDetailMoreOptions")}</DropdownMenuItem>
              <DropdownMenuItem onSelect={onDuplicate}>{tCommon("duplicate")}</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={onDelete}>
                {tCommon("delete")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        }
      />
      <AgentDetailStatus {...status} />
      <MeSection title={t("mobileDetailGeneral")} withSeparators>
        <MeRow
          label={t("inspectorEnabled")}
          value={
            <Switch
              checked={agent.enabled}
              disabled={updatingEnabled}
              aria-label={t("inspectorEnabled")}
              onCheckedChange={(enabled) => void enable(enabled)}
            />
          }
        />
        {row("name", [agent.name, agent.description].filter(Boolean).join(" · "))}
      </MeSection>
      <MeSection title={t("sectionConnection")} withSeparators>
        {agent.transport === "stdio"
          ? [
              row("command", saved.processCommand),
              row("arguments", saved.processArgs),
              row("cwd", saved.processCwd),
            ]
          : [
              row("endpoint", saved.networkEndpoint),
              row(
                "apiKey",
                agent.credentialRefs?.apiKey || agent.network?.apiKey ? t("mobileDetailSaved") : ""
              ),
            ]}
      </MeSection>
      <MeSection title={t("mobileDetailBehaviour")} withSeparators>
        {row("permission", t(PERMISSION_MODE_LABEL_KEY[permission]))}
        {agent.transport === "stdio"
          ? row(
              "state",
              tState(agent.stateIsolation === "isolated" ? "isolatedLabel" : "sharedLabel")
            )
          : null}
        {row(
          "sessions",
          agent.maxConcurrentSessions
            ? String(agent.maxConcurrentSessions)
            : tInstance("sessionLimitUnlimited")
        )}
        {row(
          "retry",
          t("sectionRetrySummary", {
            timeout: (agent.timeout ?? 300000) / 1000,
            retries: agent.retryConfig?.maxRetries ?? 3,
          })
        )}
        {row(
          "webSearch",
          t(
            webSearch === "auto"
              ? "declaredWebSearchAuto"
              : webSearch === "native"
                ? "declaredWebSearchNative"
                : "declaredWebSearchNone"
          )
        )}
      </MeSection>
      {diagnostics.length ? (
        <MeSection title={t("mobileDetailDiagnostics")} withSeparators>
          {diagnostics.map((item) => (
            <MeRow key={item} label={diagnosticTitles[item]} onClick={() => setDiagnostic(item)} />
          ))}
        </MeSection>
      ) : null}
      <MeSection title={t("mobileDetailManage")} withSeparators>
        <MeRow label={t("mobileDetailMoreOptions")} onClick={onEdit} />
        <MeRow label={tCommon("duplicate")} onClick={onDuplicate} />
        <MeRow label={tCommon("delete")} destructive onClick={onDelete} />
      </MeSection>
      {editor ? (
        <FieldEditorDrawer
          key={editor}
          open
          onOpenChange={(open) => {
            if (!open) setEditor(null)
          }}
          title={titles[editor]}
          onSave={save}
          testid="agent-field-editor"
        >
          {editors[editor]}
          {Object.entries(errors)
            .filter(([field]) => !EDITOR_FIELDS[editor]?.includes(field as keyof ConnectionDraft))
            .map(([field, key]) =>
              key ? (
                <p key={field} role="alert" className="text-sm text-destructive">
                  {key === "invalidIdleTimeout" ? tManage(key) : t(key)}
                </p>
              ) : null
            )}
          {saveError ? (
            <p role="alert" className="text-sm text-destructive">
              {saveError}
            </p>
          ) : null}
        </FieldEditorDrawer>
      ) : null}
      {diagnostic ? (
        <ResponsiveFormDialog
          open
          onOpenChange={(open) => {
            if (!open) setDiagnostic(null)
          }}
          title={diagnosticTitles[diagnostic]}
          testid="agent-diagnostics"
          footer={
            <Button variant="outline" onClick={() => setDiagnostic(null)}>
              {tCommon("close")}
            </Button>
          }
        >
          {diagnostic === "codex" ? (
            <CodexAppServerStatusCard agentId={agent.id} connected={connected} />
          ) : diagnostic === "opencode" ? (
            <OpencodeStatusCard agentId={agent.id} connected={connected} />
          ) : diagnostic === "pi" ? (
            <PiAuthStatusCard agentId={agent.id} connected={connected} />
          ) : (
            <KimiManagementCard agent={agent} />
          )}
        </ResponsiveFormDialog>
      ) : null}
    </div>
  )
}
