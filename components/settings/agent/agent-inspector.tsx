"use client"

/**
 * AgentInspector — the detail pane for one selected external agent.
 *
 * Header (brand icon, name, protocol/transport/support badges, state pill,
 * connect / edit / delete) → readiness strip (full pipeline + the one next
 * action) → tabs:
 *
 *   Overview    description, lifecycle/consent notices, ecosystem metadata,
 *               the per-protocol live status cards
 *   Connection  inline-editable transport fields (command/args/cwd or
 *               endpoint/API key) — the common "fix the address" case that
 *               previously required reopening the full editor dialog
 *   Advanced    timeout + retry numbers, permission mode, declared web
 *               search, ACP feature switches, provider-undo reset
 *
 * Inline edits go through the lifecycle service (`applyUpdate`), same as the
 * dialog — a direct store write persisted the change but left the runtime
 * manager holding the old configuration.
 */

import { useCallback, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { Edit, Loader2, Power, PowerOff, Trash2 } from "lucide-react"

import { toast } from "@/components/ui/sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ExternalLink } from "lucide-react"
import { BrandIcon } from "@/components/icons/brand-icon"
import { LifecycleStatusNotice } from "@/components/agent/external-agent/lifecycle-status-notice"
import { UnsandboxedConsentAction } from "@/components/agent/external-agent/unsandboxed-consent-action"
import { UnsandboxedStatusBadge } from "@/components/agent/external-agent/unsandboxed-status-badge"
import { SandboxPlacementBadge } from "@/components/agent/external-agent/sandbox-placement-badge"
import { lifecycleErrorMessage } from "@/lib/ai/agent/external/lifecycle/error-messages"
import { getExternalAgentLifecycleService } from "@/lib/ai/agent/external/lifecycle/service"
import { getExternalAgentEcosystemReadiness } from "@/lib/ai/agent/external/config/config-normalizer"
import { isFromPreset } from "@/lib/ai/agent/external/config/presets"
import {
  adaptPermissionMode,
  supportedPermissionModes,
} from "@/lib/ai/agent/external/policy/permission-modes"
import type { AcpPreviewFeature } from "@/lib/ai/agent/external/runtimes/acp/acp-feature-profile"
import type { AgentReadiness, AgentReadinessAction } from "@/lib/ai/agent/external/agent-readiness"
import {
  useExternalAgentStore,
  type LifecycleExternalAgentConfig,
} from "@/stores/agent/external-agent-store"
import type { AcpPermissionMode, UpdateExternalAgentInput } from "@/types/agent/external-agent"
import { AgentReadinessPipeline, AgentStatePill } from "./agent-readiness-pipeline"
import { CodexAppServerStatusCard } from "./codex-app-server-status-card"
import { OpencodeStatusCard } from "./opencode-status-card"
import { PiAuthStatusCard } from "./pi-auth-status-card"
import { PERMISSION_MODE_LABEL_KEY, declaredWebSearchOf } from "./agent-editor-dialog"

const ACP_PREVIEW_FEATURES: readonly AcpPreviewFeature[] = [
  "compaction",
  "providers",
  "dynamicMcp",
  "nes",
  "identifiedPlans",
  "previewToolNames",
  "sessionFork",
]

const INSPECTOR_ACTION_KEY: Record<AgentReadinessAction, string> = {
  enable: "actions.enable",
  inspect: "actions.inspect",
  retry: "actions.retry",
  connect: "actions.connect",
  "add-rule": "actions.addRule",
}

interface ConnectionDraft {
  processCommand: string
  processArgs: string
  processCwd: string
  networkEndpoint: string
  networkApiKey: string
  timeoutMs: string
  retryMaxRetries: string
  retryDelayMs: string
  retryMaxDelayMs: string
  retryExponentialBackoff: boolean
}

function draftFromAgent(agent: LifecycleExternalAgentConfig): ConnectionDraft {
  return {
    processCommand: agent.process?.command ?? "",
    processArgs: Array.isArray(agent.process?.args) ? agent.process.args.join(" ") : "",
    processCwd: agent.process?.cwd ?? "",
    networkEndpoint: agent.network?.endpoint ?? "",
    networkApiKey: agent.network?.apiKey ?? "",
    timeoutMs: String(agent.timeout ?? 300000),
    retryMaxRetries: String(agent.retryConfig?.maxRetries ?? 3),
    retryDelayMs: String(agent.retryConfig?.retryDelay ?? 1000),
    retryMaxDelayMs: String(agent.retryConfig?.maxRetryDelay ?? 30000),
    retryExponentialBackoff: agent.retryConfig?.exponentialBackoff ?? true,
  }
}

function AcpFeatureSettings({
  agent,
  applyUpdate,
}: {
  agent: LifecycleExternalAgentConfig
  applyUpdate: (updates: UpdateExternalAgentInput) => Promise<void>
}) {
  const t = useTranslations("externalAgent.settings")
  const preview =
    agent.metadata?.acpPreviewFeatures && typeof agent.metadata.acpPreviewFeatures === "object"
      ? (agent.metadata.acpPreviewFeatures as Partial<Record<AcpPreviewFeature, boolean>>)
      : {}
  const updateMetadata = (next: Record<string, unknown>) =>
    applyUpdate({ metadata: { ...(agent.metadata ?? {}), ...next } })

  return (
    <div className="space-y-3 rounded-md border p-3" data-testid="acp-feature-settings">
      <div>
        <p className="text-sm font-medium">{t("acpFeatureSettingsTitle")}</p>
        <p className="text-xs text-muted-foreground">{t("acpFeatureSettingsDescription")}</p>
      </div>
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={`acp-elicitation-${agent.id}`} className="text-sm font-normal">
          {t("acpStableElicitation")}
        </Label>
        <Switch
          id={`acp-elicitation-${agent.id}`}
          checked={agent.metadata?.acpElicitationEnabled !== false}
          onCheckedChange={(checked) => {
            void updateMetadata({ acpElicitationEnabled: checked })
          }}
        />
      </div>
      <Separator />
      <p className="text-xs font-medium text-muted-foreground">{t("acpPreviewFeatures")}</p>
      {ACP_PREVIEW_FEATURES.map((feature) => (
        <div key={feature} className="flex items-center justify-between gap-3">
          <Label htmlFor={`acp-preview-${agent.id}-${feature}`} className="text-sm font-normal">
            {t(`acpPreview.${feature}`)}
          </Label>
          <Switch
            id={`acp-preview-${agent.id}-${feature}`}
            checked={preview[feature] === true}
            onCheckedChange={(checked) => {
              void updateMetadata({
                acpPreviewFeatures: { ...preview, [feature]: checked },
                ...(feature === "providers" ? { acpProviderController: checked } : {}),
                ...(feature === "nes" ? { acpNesController: checked } : {}),
              })
            }}
          />
        </div>
      ))}
    </div>
  )
}

export function AgentInspector({
  agent,
  readiness,
  isConnecting,
  onConnect,
  onDisconnect,
  onEdit,
  onDelete,
  onAddRule,
}: {
  agent: LifecycleExternalAgentConfig
  readiness: AgentReadiness
  isConnecting: boolean
  onConnect: () => void
  onDisconnect: () => void
  onEdit: () => void
  onDelete: () => void
  onAddRule: () => void
}) {
  const t = useTranslations("externalAgent.settings")
  const tCommon = useTranslations("common")
  const tReadiness = useTranslations("externalAgent.readiness")
  const tErrors = useTranslations("externalAgent.lifecycleErrors")
  const { getAgentValidity } = useExternalAgentStore()

  // Even a metadata-only write goes through the lifecycle service. Having one
  // path bypass the service is how the store and the live adapter drifted
  // apart in the first place.
  const applyUpdate = useCallback(
    async (updates: UpdateExternalAgentInput) => {
      const lifecycle = await getExternalAgentLifecycleService()
      await lifecycle.updateConfig(agent.id, updates)
    },
    [agent.id]
  )

  // Inline-edit draft. Resets during render (the documented alternative to a
  // setState-in-effect) whenever a different agent is selected or the store
  // lands a newer revision — a save, or reconciliation rewriting fields.
  const revision = `${agent.id}:${agent.updatedAt?.getTime() ?? 0}`
  const [draft, setDraft] = useState<ConnectionDraft>(() => draftFromAgent(agent))
  const [draftRevision, setDraftRevision] = useState(revision)
  if (draftRevision !== revision) {
    setDraftRevision(revision)
    setDraft(draftFromAgent(agent))
  }

  const baseDraft = useMemo(() => draftFromAgent(agent), [agent])
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseDraft)
  const [saving, setSaving] = useState(false)

  const saveDraft = useCallback(async () => {
    const toNonNegativeInteger = (value: string, fallback: number): number => {
      const parsed = Number.parseInt(value, 10)
      return Number.isNaN(parsed) || parsed < 0 ? fallback : parsed
    }
    const updates: UpdateExternalAgentInput = {}
    if (
      draft.processCommand !== baseDraft.processCommand ||
      draft.processArgs !== baseDraft.processArgs ||
      draft.processCwd !== baseDraft.processCwd
    ) {
      if (agent.transport === "stdio" && !draft.processCommand.trim()) {
        toast.error(t("commandRequired"))
        return
      }
      updates.process = {
        command: draft.processCommand.trim(),
        args: draft.processArgs.split(" ").filter(Boolean),
        cwd: draft.processCwd || undefined,
      }
    }
    if (
      draft.networkEndpoint !== baseDraft.networkEndpoint ||
      draft.networkApiKey !== baseDraft.networkApiKey
    ) {
      if (agent.transport !== "stdio" && !draft.networkEndpoint.trim()) {
        toast.error(t("endpointRequired"))
        return
      }
      updates.network = {
        endpoint: draft.networkEndpoint.trim(),
        apiKey: draft.networkApiKey || undefined,
      }
    }
    if (draft.timeoutMs !== baseDraft.timeoutMs) {
      updates.timeout = toNonNegativeInteger(draft.timeoutMs, 300000)
    }
    const retryChanged =
      draft.retryMaxRetries !== baseDraft.retryMaxRetries ||
      draft.retryDelayMs !== baseDraft.retryDelayMs ||
      draft.retryMaxDelayMs !== baseDraft.retryMaxDelayMs ||
      draft.retryExponentialBackoff !== baseDraft.retryExponentialBackoff
    if (retryChanged) {
      updates.retryConfig = {
        maxRetries: toNonNegativeInteger(draft.retryMaxRetries, 3),
        retryDelay: toNonNegativeInteger(draft.retryDelayMs, 1000),
        maxRetryDelay: toNonNegativeInteger(draft.retryMaxDelayMs, 30000),
        exponentialBackoff: draft.retryExponentialBackoff,
      }
    }
    setSaving(true)
    try {
      await applyUpdate(updates)
      toast.success(t("agentUpdated"))
    } catch (error) {
      toast.error(lifecycleErrorMessage(error, tErrors))
    } finally {
      setSaving(false)
    }
  }, [draft, baseDraft, agent.transport, applyUpdate, t, tErrors])

  const runAction = useCallback(
    (action: AgentReadinessAction) => {
      switch (action) {
        case "enable":
          void applyUpdate({ enabled: true })
          break
        case "inspect":
          onEdit()
          break
        case "retry":
        case "connect":
          onConnect()
          break
        case "add-rule":
          onAddRule()
          break
      }
    },
    [applyUpdate, onEdit, onConnect, onAddRule]
  )

  const runtimeValidity = getAgentValidity(agent.id)
  const ecosystem =
    runtimeValidity?.ecosystem ??
    agent.validitySnapshot?.ecosystem ??
    getExternalAgentEcosystemReadiness(agent)
  const supportTier = ecosystem?.supportTier
  const supportTierVariant =
    supportTier === "documented-only"
      ? "destructive"
      : supportTier === "guided"
        ? "secondary"
        : "outline"
  const isConnected = readiness.state === "connected"
  const presetId = isFromPreset(agent)

  const setField = <K extends keyof ConnectionDraft>(key: K, value: ConnectionDraft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }))

  const dirtyBar = dirty ? (
    <div
      className="flex items-center justify-end gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2"
      data-testid="inspector-dirty-bar"
    >
      <span className="mr-auto text-xs text-amber-600 dark:text-amber-400">
        {t("inspectorUnsaved")}
      </span>
      <Button variant="ghost" size="sm" onClick={() => setDraft(baseDraft)} disabled={saving}>
        {tCommon("cancel")}
      </Button>
      <Button size="sm" onClick={() => void saveDraft()} disabled={saving}>
        {saving ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
        {tCommon("save")}
      </Button>
    </div>
  ) : null

  return (
    <div className="space-y-4" data-testid={`agent-detail-${agent.id}`}>
      {/* Header — every action for this agent in one row next to its title. */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <BrandIcon id={presetId ?? agent.name} label={agent.name} size={20} />
            <h3 className="truncate text-base font-semibold">{agent.name}</h3>
            <Badge variant="outline" className="text-xs">
              {agent.protocol.toUpperCase()}
            </Badge>
            <Badge variant="secondary" className="text-xs">
              {agent.transport}
            </Badge>
            {supportTier && (
              <Badge variant={supportTierVariant} className="text-xs">
                {supportTier}
              </Badge>
            )}
            {/* A decision made weeks ago governs every later run; without a
                standing indicator the one agent with no sandbox looks exactly
                like the ones that have one. */}
            <UnsandboxedStatusBadge
              unsandboxed={Boolean(agent.unsandboxedConsent)}
              executablePath={agent.unsandboxedConsent?.executablePath}
            />
            {/* ADR-0182: where the last run actually landed — the tier, user
                and digest the Host attested, which can all differ from what
                the project asked for. Nothing at all when it asked for none. */}
            <SandboxPlacementBadge agentId={agent.id} />
            <AgentStatePill readiness={readiness} />
          </div>
          {agent.description && (
            <p className="text-sm text-muted-foreground">{agent.description}</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {isConnected ? (
            <Button variant="outline" size="sm" onClick={onDisconnect}>
              <PowerOff className="mr-1 h-4 w-4" />
              {t("disconnect")}
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={onConnect}
              // A disabled agent's way back is the strip's Enable action, not
              // a connect attempt that can only fail.
              disabled={
                isConnecting || readiness.state === "blocked" || readiness.state === "disabled"
              }
            >
              {isConnecting ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <Power className="mr-1 h-4 w-4" />
              )}
              {t("connect")}
            </Button>
          )}
          <Button variant="outline" size="icon" aria-label={tCommon("edit")} onClick={onEdit}>
            <Edit className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            aria-label={tCommon("delete")}
            className="text-destructive hover:text-destructive"
            onClick={onDelete}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Readiness strip — the same pipeline the overview row shows, plus the
          reason and the one action that would move the agent forward. */}
      <div
        className="flex flex-wrap items-center gap-3 rounded-lg border bg-muted/20 px-3 py-2"
        data-testid="inspector-readiness"
      >
        <AgentReadinessPipeline readiness={readiness} />
        {readiness.blockReason ? (
          <span
            className={
              readiness.blockTransient
                ? "text-xs text-muted-foreground"
                : "text-xs text-amber-600 dark:text-amber-400"
            }
          >
            {readiness.blockReason}
          </span>
        ) : null}
        {/* connect / retry / inspect are already covered by the header's
            Connect and Edit buttons — repeating them here would render two
            identically-named actions. The strip only surfaces the steps the
            header cannot do: enable a disabled agent, add a routing rule. */}
        {readiness.nextAction === "enable" || readiness.nextAction === "add-rule" ? (
          <Button
            variant="outline"
            size="sm"
            className="ml-auto"
            data-testid="inspector-next-action"
            onClick={() => runAction(readiness.nextAction as AgentReadinessAction)}
          >
            {tReadiness(INSPECTOR_ACTION_KEY[readiness.nextAction])}
          </Button>
        ) : null}
      </div>

      <Tabs defaultValue="overview" className="w-full">
        <TabsList>
          <TabsTrigger value="overview">{t("inspectorTabOverview")}</TabsTrigger>
          <TabsTrigger value="connection">{t("inspectorTabConnection")}</TabsTrigger>
          <TabsTrigger value="advanced">{t("inspectorTabAdvanced")}</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" forceMount className="mt-3 space-y-4">
          {/* Reconciliation has always recorded WHY an agent cannot start and
              nothing read it back, so one that was switched off at startup
              looked simply disabled. */}
          <LifecycleStatusNotice
            status={agent.lifecycleStatus}
            reasonCode={agent.lifecycleReasonCode}
            action={
              agent.lifecycleStatus === "needs-consent" ? (
                <UnsandboxedConsentAction agent={agent} />
              ) : null
            }
          />

          <div className="grid grid-cols-1 gap-x-6 gap-y-1.5 text-sm @lg/agents-pane:grid-cols-2">
            <div>
              <span className="text-muted-foreground">{t("transport")}:</span>
              <span className="ml-2">{agent.transport}</span>
            </div>
            <div>
              <span className="text-muted-foreground">{t("detailTimeout")}:</span>
              <span className="ml-2">{agent.timeout ?? 300000}ms</span>
            </div>
            <div>
              <span className="text-muted-foreground">{t("detailRetry")}:</span>
              <span className="ml-2">
                {agent.retryConfig?.maxRetries ?? 3} @ {agent.retryConfig?.retryDelay ?? 1000}ms
              </span>
            </div>
            <div>
              <span className="text-muted-foreground">{t("detailBackoff")}:</span>
              <span className="ml-2">
                {(agent.retryConfig?.exponentialBackoff ?? true)
                  ? t("backoffExponential")
                  : t("backoffFixed")}
              </span>
            </div>
            {agent.process && (
              <>
                <div>
                  <span className="text-muted-foreground">{t("command")}:</span>
                  <code className="ml-2 rounded bg-muted px-1 text-xs">
                    {agent.process.command}
                  </code>
                </div>
                {agent.process.cwd && (
                  <div className="@lg/agents-pane:col-span-2">
                    <span className="text-muted-foreground">{t("workingDirectory")}:</span>
                    <code className="ml-2 rounded bg-muted px-1 text-xs">{agent.process.cwd}</code>
                  </div>
                )}
              </>
            )}
            {agent.network?.endpoint && (
              <div className="@lg/agents-pane:col-span-2">
                <span className="text-muted-foreground">{t("endpoint")}:</span>
                <code className="ml-2 rounded bg-muted px-1 text-xs">{agent.network.endpoint}</code>
              </div>
            )}
            {ecosystem?.adapterName && (
              <div>
                <span className="text-muted-foreground">{t("detailsAdapter")}:</span>
                <span className="ml-2">{ecosystem.adapterName}</span>
              </div>
            )}
            {ecosystem?.surfaceName && (
              <div>
                <span className="text-muted-foreground">{t("detailsSurface")}:</span>
                <span className="ml-2">{ecosystem.surfaceName}</span>
              </div>
            )}
            {/* Support tier is already a badge in the header — not repeated here. */}
            {ecosystem?.prerequisiteStatus && (
              <div>
                <span className="text-muted-foreground">{t("detailsPrerequisiteStatus")}:</span>
                <span className="ml-2">{ecosystem.prerequisiteStatus}</span>
              </div>
            )}
            {ecosystem?.docsUrl && (
              <div className="@lg/agents-pane:col-span-2">
                <span className="text-muted-foreground">{t("detailsOfficialDocs")}:</span>
                <a
                  href={ecosystem.docsUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="ml-2 inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  {t("detailsDocsLink")}
                </a>
              </div>
            )}
            {ecosystem?.limitationNote && (
              <div className="@lg/agents-pane:col-span-2">
                <span className="text-muted-foreground">{t("detailsLimitation")}:</span>
                <span className="ml-2">{ecosystem.limitationNote}</span>
              </div>
            )}
            {ecosystem?.recommendedActions?.length ? (
              <div className="@lg/agents-pane:col-span-2">
                <span className="text-muted-foreground">{t("detailsRecommendedActions")}:</span>
                <span className="ml-2">{ecosystem.recommendedActions.join(" | ")}</span>
              </div>
            ) : null}
          </div>

          {/* Native Codex app-server status (MCP servers + skills) */}
          {agent.protocol === "codex-app-server" && (
            <CodexAppServerStatusCard agentId={agent.id} connected={isConnected} />
          )}

          {/* OpenCode server status (project / providers / agents / MCP / LSP) */}
          {agent.protocol === "opencode" && (
            <OpencodeStatusCard agentId={agent.id} connected={isConnected} />
          )}

          {/* Pi native RPC: which providers Pi can actually authenticate (ADR-0119). */}
          {agent.protocol === "pi-rpc" && (
            <PiAuthStatusCard agentId={agent.id} connected={isConnected} />
          )}
        </TabsContent>

        {/* Connection — the transport fields, editable inline. Only the
            transport in use renders: stdio shows command/args/cwd, network
            transports show endpoint + key. Protocol-specific options (Codex
            sandbox, OpenCode spawn, Pi policy) stay in the editor dialog. */}
        <TabsContent value="connection" forceMount className="mt-3 space-y-4">
          {agent.transport === "stdio" ? (
            <>
              <div className="grid gap-2">
                <Label htmlFor={`inspector-command-${agent.id}`}>{t("command")}</Label>
                <Input
                  id={`inspector-command-${agent.id}`}
                  value={draft.processCommand}
                  onChange={(e) => setField("processCommand", e.target.value)}
                  data-testid="inspector-command"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor={`inspector-args-${agent.id}`}>{t("arguments")}</Label>
                <Input
                  id={`inspector-args-${agent.id}`}
                  value={draft.processArgs}
                  onChange={(e) => setField("processArgs", e.target.value)}
                  data-testid="inspector-args"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor={`inspector-cwd-${agent.id}`}>{t("workingDirectory")}</Label>
                <Input
                  id={`inspector-cwd-${agent.id}`}
                  value={draft.processCwd}
                  onChange={(e) => setField("processCwd", e.target.value)}
                  placeholder={t("cwdPlaceholder")}
                />
              </div>
            </>
          ) : (
            <>
              <div className="grid gap-2">
                <Label htmlFor={`inspector-endpoint-${agent.id}`}>{t("endpoint")}</Label>
                <Input
                  id={`inspector-endpoint-${agent.id}`}
                  value={draft.networkEndpoint}
                  onChange={(e) => setField("networkEndpoint", e.target.value)}
                  data-testid="inspector-endpoint"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor={`inspector-apikey-${agent.id}`}>{t("apiKey")}</Label>
                <Input
                  id={`inspector-apikey-${agent.id}`}
                  type="password"
                  value={draft.networkApiKey}
                  onChange={(e) => setField("networkApiKey", e.target.value)}
                  placeholder={t("apiKeyPlaceholder")}
                />
              </div>
            </>
          )}
        </TabsContent>

        <TabsContent value="advanced" forceMount className="mt-3 space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor={`inspector-timeout-${agent.id}`}>{t("executionTimeoutMs")}</Label>
              <Input
                id={`inspector-timeout-${agent.id}`}
                type="number"
                min={1000}
                step={1000}
                value={draft.timeoutMs}
                onChange={(e) => setField("timeoutMs", e.target.value)}
                data-testid="inspector-timeout"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor={`inspector-retries-${agent.id}`}>{t("maxRetries")}</Label>
              <Input
                id={`inspector-retries-${agent.id}`}
                type="number"
                min={0}
                step={1}
                value={draft.retryMaxRetries}
                onChange={(e) => setField("retryMaxRetries", e.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor={`inspector-retry-delay-${agent.id}`}>{t("retryDelayMs")}</Label>
              <Input
                id={`inspector-retry-delay-${agent.id}`}
                type="number"
                min={0}
                step={100}
                value={draft.retryDelayMs}
                onChange={(e) => setField("retryDelayMs", e.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor={`inspector-retry-max-${agent.id}`}>{t("maxRetryDelayMs")}</Label>
              <Input
                id={`inspector-retry-max-${agent.id}`}
                type="number"
                min={0}
                step={100}
                value={draft.retryMaxDelayMs}
                onChange={(e) => setField("retryMaxDelayMs", e.target.value)}
              />
            </div>
          </div>
          <div className="grid gap-2 sm:max-w-xs">
            <Label>{t("backoffStrategy")}</Label>
            <Select
              value={draft.retryExponentialBackoff ? "true" : "false"}
              onValueChange={(value) => setField("retryExponentialBackoff", value === "true")}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="true">{t("backoffExponential")}</SelectItem>
                <SelectItem value="false">{t("backoffFixedDelay")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2 sm:max-w-xs">
            <Label>{t("defaultPermissionMode")}</Label>
            <Select
              value={
                adaptPermissionMode(agent.defaultPermissionMode ?? "default", agent.protocol).mode
              }
              onValueChange={(v) => {
                void applyUpdate({ defaultPermissionMode: v as AcpPermissionMode })
              }}
            >
              <SelectTrigger data-testid="inspector-permission-mode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {supportedPermissionModes(agent.protocol).map((mode) => (
                  <SelectItem key={mode} value={mode}>
                    {t(PERMISSION_MODE_LABEL_KEY[mode])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {/* Whether the binary reaches the web on its own — a property of
              what the user installed, not the wire protocol. */}
          <div className="grid gap-2 sm:max-w-xs">
            <Label>{t("declaredWebSearch")}</Label>
            <Select
              value={declaredWebSearchOf(agent.declaredCapabilities) || "auto"}
              onValueChange={(v) => {
                // `declaredCapabilities` is replaced wholesale on update, so
                // keep any other declared levels and only touch web.search:
                // "auto" deletes the key, otherwise the level is pinned.
                const caps = { ...(agent.declaredCapabilities ?? {}) }
                if (v === "auto") {
                  delete caps["web.search"]
                } else {
                  caps["web.search"] = v as "native" | "unsupported"
                }
                void applyUpdate({ declaredCapabilities: caps })
              }}
            >
              <SelectTrigger data-testid="inspector-declared-web-search">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">{t("declaredWebSearchAuto")}</SelectItem>
                <SelectItem value="native">{t("declaredWebSearchNative")}</SelectItem>
                <SelectItem value="unsupported">{t("declaredWebSearchNone")}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {agent.protocol === "acp" && (
            <AcpFeatureSettings agent={agent} applyUpdate={applyUpdate} />
          )}

          {agent.metadata?.providerUndoWarningAcknowledged === true && (
            <div className="flex items-center justify-between gap-3 rounded-md border p-3">
              <div>
                <p className="text-sm font-medium">{t("providerUndoWarningSetting")}</p>
                <p className="text-xs text-muted-foreground">
                  {t("providerUndoWarningSettingDescription")}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  void applyUpdate({ metadata: { providerUndoWarningAcknowledged: false } })
                }}
                data-testid="reset-provider-undo-warning"
              >
                {t("providerUndoWarningReset")}
              </Button>
            </div>
          )}
        </TabsContent>
      </Tabs>

      {/* One dirty bar for the whole draft — the fields it saves span the
          Connection and Advanced tabs. */}
      {dirtyBar}
    </div>
  )
}
