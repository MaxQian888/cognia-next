"use client"

import { isCodexAppServerProtocol } from "@/lib/ai/agent/external/protocol-options"

/**
 * AgentInspector — the detail pane for one selected external agent.
 *
 * Header (brand icon, inline-renamable name and description, protocol /
 * transport / support / state-isolation badges, "copy of" lineage, state
 * pill, enable switch, connect / edit / duplicate / delete) → readiness strip
 * (full pipeline + the one next action) → tabs:
 *
 *   Overview    lifecycle/consent notices, this configuration among the
 *               others of its runtime (state isolation, its state folder,
 *               session limit, siblings and what differs, ADR-0216),
 *               ecosystem metadata, the per-protocol live status cards
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

import { Spinner } from "@/components/ui/spinner"
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { Check, Copy, Edit, Pencil, Power, PowerOff, MoreHorizontal, Trash2, X } from "lucide-react"

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
import { Textarea } from "@/components/ui/textarea"
import { BrandIcon } from "@/components/icons/brand-icon"
import {
  DuplicatedFromHint,
  StateIsolationBadge,
} from "@/components/agent/external-agent/instance-traits"
import { supportTierLabel } from "@/components/agent/external-agent/add-agent/preset-copy"
import { UnsandboxedStatusBadge } from "@/components/agent/external-agent/unsandboxed-status-badge"
import { SandboxDeliveryHistory } from "@/components/agent/external-agent/sandbox-delivery-history"
import { SandboxPlacementBadge } from "@/components/agent/external-agent/sandbox-placement-badge"
import { lifecycleErrorMessage } from "@/lib/ai/agent/external/lifecycle/error-messages"
import { getExternalAgentLifecycleService } from "@/lib/ai/agent/external/lifecycle/service"
import { getExternalAgentEcosystemReadiness } from "@/lib/ai/agent/external/config/config-normalizer"
import { isFromPreset } from "@/lib/ai/agent/external/config/presets"
import { findRuntimeForConfig } from "@/lib/ai/agent/external/config/install-catalog"
import {
  adaptPermissionMode,
  supportedPermissionModes,
} from "@/lib/ai/agent/external/policy/permission-modes"
import type { AcpPreviewFeature } from "@cognia/agent-acp/feature-profile"
import type { AgentReadiness } from "@/lib/ai/agent/external/agent-readiness"
import {
  useExternalAgentStore,
  type LifecycleExternalAgentConfig,
} from "@/stores/agent/external-agent-store"
import type { AcpPermissionMode, UpdateExternalAgentInput } from "@/types/agent/external-agent"
import { AgentStatePill } from "./agent-readiness-pipeline"
import { CodexAppServerStatusCard } from "./codex-app-server-status-card"
import { OpencodeStatusCard } from "./opencode-status-card"
import { PiAuthStatusCard } from "./pi-auth-status-card"
import { KimiManagementCard } from "./kimi-management-card"
import { PERMISSION_MODE_LABEL_KEY, declaredWebSearchOf } from "./agent-editor-dialog"
import {
  SettingsStack,
  SettingsBlock,
  SettingsField,
} from "@/components/settings/common/settings-block"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu"
import { AgentStatusBlock } from "./agent-status-block"
import { AgentInstanceSection } from "./agent-instance-section"
import { UnsavedBar } from "@/components/settings/common/unsaved-bar"
import {
  buildDraftUpdate,
  countDirtyFields,
  draftFromAgent,
  rebaseDraft,
  type ConnectionDraft,
} from "./inspector-draft"

const ACP_PREVIEW_FEATURES: readonly AcpPreviewFeature[] = [
  "compaction",
  "providers",
  "dynamicMcp",
  "nes",
  "identifiedPlans",
  "previewToolNames",
  "sessionFork",
]

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
    <SettingsBlock
      title={t("acpFeatureSettingsTitle")}
      description={t("acpFeatureSettingsDescription")}
      testid="acp-feature-settings"
    >
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
    </SettingsBlock>
  )
}

export function AgentInspector({
  agent,
  allAgents,
  readiness,
  isConnecting,
  masterEnabled,
  onOpenRuntimes,
  onOpenPlugins,
  onConnect,
  onDisconnect,
  onEdit,
  onDuplicate,
  onDelete,
  onAddRule,
  onOpenAgent,
  onDirtyChange,
}: {
  agent: LifecycleExternalAgentConfig
  /** Every configuration, for the siblings of this one's runtime. */
  allAgents: readonly LifecycleExternalAgentConfig[]
  readiness: AgentReadiness
  isConnecting: boolean
  masterEnabled: boolean
  onOpenRuntimes: () => void
  onOpenPlugins: () => void
  onConnect: () => void
  onDisconnect: () => void
  onEdit: () => void
  /** Create a copy of this configuration, credentials included. */
  onDuplicate: () => void
  onDelete: () => void
  onAddRule: () => void
  /** Select another agent (a sibling, the source of a copy). */
  onOpenAgent: (agentId: string) => void
  onDirtyChange?: (dirty: boolean) => void
}) {
  const t = useTranslations("externalAgent.settings")
  const tCommon = useTranslations("common")
  const tManage = useTranslations("externalAgentManage.editor")
  const tErrors = useTranslations("externalAgent.lifecycleErrors")
  const tTier = useTranslations("externalAgent.supportTier")
  const tPrereq = useTranslations("externalAgent.prerequisiteStatus")
  const tDiagnostics = useTranslations("diagnostics")
  const ids = useId()
  const [renaming, setRenaming] = useState(false)
  const [tab, setTab] = useState("overview")
  const [focusInstance, setFocusInstance] = useState<"section" | "session-limit" | null>(null)
  const instanceRef = useRef<HTMLDivElement>(null)
  const sessionLimitRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!focusInstance || tab !== "overview") return
    // Tabs mount their content through Presence; focus after that mount commits.
    const frame = requestAnimationFrame(() => {
      instanceRef.current?.scrollIntoView?.({ block: "start", behavior: "smooth" })
      if (focusInstance === "session-limit") sessionLimitRef.current?.focus()
      else instanceRef.current?.focus()
      setFocusInstance(null)
    })
    return () => cancelAnimationFrame(frame)
  }, [focusInstance, tab])
  const openInstance = (target: "section" | "session-limit") => {
    setTab("overview")
    setFocusInstance(target)
  }
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

  const applyInstantUpdate = useCallback(
    async (updates: UpdateExternalAgentInput, announceSuccess = false) => {
      try {
        await applyUpdate(updates)
        if (announceSuccess) toast.success(t("agentUpdated"))
      } catch (error) {
        toast.error(lifecycleErrorMessage(error, tErrors))
      }
    },
    [applyUpdate, t, tErrors]
  )

  const revision = `${agent.id}:${agent.updatedAt?.getTime() ?? 0}`
  const baseDraft = useMemo(() => draftFromAgent(agent), [agent])
  const [draft, setDraft] = useState<ConnectionDraft>(() => baseDraft)
  const [baseline, setBaseline] = useState(() => ({ id: agent.id, revision, draft: baseDraft }))
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const activeAgent = useRef<string | null>(agent.id)
  useEffect(() => {
    activeAgent.current = agent.id
    return () => {
      activeAgent.current = null
      if (savedTimer.current) clearTimeout(savedTimer.current)
    }
  }, [agent.id])
  if (baseline.revision !== revision) {
    setDraft(baseline.id === agent.id ? rebaseDraft(draft, baseline.draft, baseDraft) : baseDraft)
    setBaseline({ id: agent.id, revision, draft: baseDraft })
    if (baseline.id !== agent.id) {
      setRenaming(false)
      setSaved(false)
      setSaving(false)
    }
  }
  const dirtyCount = countDirtyFields(draft, baseDraft)
  const dirty = dirtyCount > 0
  const dirtyCallback = useRef(onDirtyChange)
  const reportedDirty = useRef(false)
  useEffect(() => {
    dirtyCallback.current = onDirtyChange
  }, [onDirtyChange])
  useEffect(() => {
    if (reportedDirty.current !== dirty) {
      reportedDirty.current = dirty
      dirtyCallback.current?.(dirty)
    }
  }, [dirty])
  useEffect(
    () => () => {
      dirtyCallback.current?.(false)
    },
    []
  )

  const saveDraft = useCallback(async () => {
    const { updates, errors } = buildDraftUpdate(agent, draft, baseDraft)
    const firstError = Object.values(errors)[0]
    if (firstError) {
      toast.error(firstError === "invalidIdleTimeout" ? tManage(firstError) : t(firstError))
      return
    }
    setSaving(true)
    try {
      await applyUpdate(updates)
      if (activeAgent.current !== agent.id) return
      const persistedDraft = draftFromAgent({
        ...agent,
        ...updates,
      } as LifecycleExternalAgentConfig)
      setDraft((current) => rebaseDraft(current, draft, persistedDraft))
      toast.success(t("agentUpdated"))
      setRenaming(false)
      setSaved(true)
      if (savedTimer.current) clearTimeout(savedTimer.current)
      savedTimer.current = setTimeout(() => setSaved(false), 2000)
    } catch (error) {
      toast.error(lifecycleErrorMessage(error, tErrors))
    } finally {
      if (activeAgent.current === agent.id) setSaving(false)
    }
  }, [draft, baseDraft, agent, applyUpdate, t, tErrors, tManage])

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
  const transportLabel =
    agent.transport === "stdio"
      ? t("transportStdioLabel")
      : agent.transport === "http"
        ? t("transportHttpLabel")
        : agent.transport
  // Lineage only while the source still exists; a deleted source says nothing.
  const duplicatedFrom = agent.duplicatedFromAgentId
    ? allAgents.find((other) => other.id === agent.duplicatedFromAgentId)
    : undefined
  // Entries are either a `{ id, params }` message reference or prose a preset
  // supplied; prose is shown as written (see the chat-side manager).
  const recommendedActions = (ecosystem?.recommendedActions ?? []).map((action) => {
    if (typeof action === "string") return action
    const key = `recommendedAction.${action.id}`
    return tDiagnostics.has(key) ? tDiagnostics(key, action.params ?? {}) : action.id
  })

  const setField = <K extends keyof ConnectionDraft>(key: K, value: ConnectionDraft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }))

  const dirtyBar = (
    <div className="sticky bottom-0 z-10 pt-2">
      <UnsavedBar
        status={saving ? "saving" : dirty ? "dirty" : saved ? "saved" : "clean"}
        count={dirtyCount}
        onSave={() => void saveDraft()}
        onDiscard={() => {
          setDraft(baseDraft)
          setSaved(false)
        }}
      />
    </div>
  )

  return (
    <div className="space-y-4" data-testid={`agent-detail-${agent.id}`}>
      {/* Header — every action for this agent next to its title. It wraps
          rather than squeezing: the detail column can be phone-narrow. */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 basis-64 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <BrandIcon
              id={presetId ?? findRuntimeForConfig(agent)?.runtimeId ?? agent.name}
              label={agent.name}
              size={20}
            />
            {renaming ? (
              <span className="flex min-w-0 flex-1 basis-48 items-center gap-1">
                <Label htmlFor={`${ids}-name`} className="sr-only">
                  {t("inspectorNameLabel")}
                </Label>
                <Input
                  id={`${ids}-name`}
                  value={draft.name}
                  autoFocus
                  onChange={(event) => setField("name", event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void saveDraft()
                    if (event.key === "Escape") {
                      setField("name", baseDraft.name)
                      setRenaming(false)
                    }
                  }}
                  className="h-8"
                  data-testid="inspector-name"
                />
                <Button
                  variant="ghost"
                  size="icon"
                  className="touch-hit size-8"
                  aria-label={tCommon("save")}
                  onClick={() => void saveDraft()}
                  disabled={saving}
                >
                  <Check className="size-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="touch-hit size-8"
                  aria-label={tCommon("cancel")}
                  onClick={() => {
                    setField("name", baseDraft.name)
                    setRenaming(false)
                  }}
                >
                  <X className="size-4" />
                </Button>
              </span>
            ) : (
              <span className="flex min-w-0 items-center gap-1">
                <h3
                  tabIndex={-1}
                  data-detail-heading={`agent-${agent.id}`}
                  className="break-all text-base font-semibold"
                >
                  {agent.name}
                </h3>
                <Button
                  variant="ghost"
                  size="icon"
                  className="touch-hit size-7 shrink-0 text-muted-foreground"
                  aria-label={t("inspectorRename", { name: agent.name })}
                  onClick={() => setRenaming(true)}
                  data-testid="inspector-rename"
                >
                  <Pencil className="size-3.5" />
                </Button>
              </span>
            )}
            <AgentStatePill readiness={readiness} />
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="outline" className="text-xs">
              {agent.protocol.toUpperCase()}
            </Badge>
            <Badge variant="secondary" className="text-xs">
              {transportLabel}
            </Badge>
            {supportTier && (
              <Badge variant={supportTierVariant} className="text-xs">
                {supportTierLabel(tTier, supportTier)}
              </Badge>
            )}
            <StateIsolationBadge config={agent} />
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
          </div>
          <DuplicatedFromHint
            sourceName={duplicatedFrom?.name ?? null}
            onOpenSource={duplicatedFrom ? () => onOpenAgent(duplicatedFrom.id) : undefined}
          />
          <div className="grid gap-1">
            <Label htmlFor={`${ids}-description`} className="sr-only">
              {t("inspectorDescriptionLabel")}
            </Label>
            <Textarea
              id={`${ids}-description`}
              value={draft.description}
              onChange={(event) => setField("description", event.target.value)}
              placeholder={t("inspectorDescriptionPlaceholder")}
              rows={1}
              className="min-h-8 resize-none border-transparent bg-transparent px-1 py-1 text-sm text-muted-foreground shadow-none hover:border-input focus-visible:border-input"
              data-testid="inspector-description"
            />
          </div>
        </div>
        <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5">
            <Switch
              id={`${ids}-enabled`}
              checked={agent.enabled}
              onCheckedChange={(checked) => {
                void applyInstantUpdate({ enabled: checked }, true)
              }}
              aria-label={t("inspectorEnabledAria", { name: agent.name })}
              data-testid="inspector-enabled"
            />
            <Label htmlFor={`${ids}-enabled`} className="text-xs text-muted-foreground">
              {t("inspectorEnabled")}
            </Label>
          </div>
          {isConnected ? (
            <Button size="sm" onClick={onDisconnect}>
              <PowerOff className="mr-1 h-4 w-4" />
              {t("disconnect")}
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={onConnect}
              title={!masterEnabled ? t("inspectorMasterDisabled") : undefined}
              aria-describedby={!masterEnabled ? `${ids}-master-disabled` : undefined}
              // A disabled agent's way back is its Enable switch, not a
              // connect attempt that can only fail.
              disabled={
                !masterEnabled ||
                isConnecting ||
                readiness.state === "blocked" ||
                readiness.state === "disabled"
              }
            >
              {isConnecting ? (
                <Spinner className="mr-1 h-4 w-4" />
              ) : (
                <Power className="mr-1 h-4 w-4" />
              )}
              {t("connect")}
            </Button>
          )}
          {!masterEnabled && (
            <span id={`${ids}-master-disabled`} className="sr-only">
              {t("inspectorMasterDisabled")}
            </span>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="touch-hit"
                aria-label={t("inspectorActionsAria", { name: agent.name })}
                data-testid="inspector-actions-menu"
              >
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onSelect={onEdit}
                aria-label={t("inspectorEditAria", { name: agent.name })}
              >
                <Edit className="size-4" />
                {t("inspectorEditAll")}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={onDuplicate}
                aria-label={t("inspectorDuplicateAria", { name: agent.name })}
                data-testid="inspector-duplicate"
              >
                <Copy className="size-4" />
                {tCommon("duplicate")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onSelect={onDelete}
                aria-label={t("inspectorDeleteAria", { name: agent.name })}
              >
                <Trash2 className="size-4" />
                {tCommon("delete")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <AgentStatusBlock
        agent={agent}
        readiness={readiness}
        masterEnabled={masterEnabled}
        isConnecting={isConnecting}
        onConnect={onConnect}
        onEnable={() => void applyInstantUpdate({ enabled: true })}
        onEdit={onEdit}
        onOpenRuntimes={onOpenRuntimes}
        onOpenPlugins={onOpenPlugins}
        onAddRule={onAddRule}
        onUseSharedState={() => {
          setField("stateIsolation", "shared")
          openInstance("section")
        }}
        onEditSessionLimit={() => openInstance("session-limit")}
      />

      <SandboxDeliveryHistory agentId={agent.id} />

      <Tabs value={tab} onValueChange={setTab} className="w-full min-w-0">
        <TabsList className="grid h-auto w-full grid-cols-3 [&>*]:min-w-0 [&>*]:whitespace-normal">
          <TabsTrigger value="overview">{t("inspectorTabOverview")}</TabsTrigger>
          <TabsTrigger value="connection">{t("inspectorTabConnection")}</TabsTrigger>
          <TabsTrigger value="advanced">{t("inspectorTabAdvanced")}</TabsTrigger>
        </TabsList>

        {/* No `forceMount`: Radix keeps a force-mounted panel visible (its
            `hidden` follows presence), so all three panels used to show at
            once under a tab strip that did nothing. The draft lives here, not
            in the inputs, so an unmounted panel loses nothing. */}
        <TabsContent value="overview" className="mt-3 space-y-4">
          <SettingsStack>
            <div ref={instanceRef} tabIndex={-1} data-testid="inspector-instance-focus">
              <AgentInstanceSection
                sessionLimitRef={sessionLimitRef}
                agent={agent}
                allAgents={allAgents}
                draftIsolation={draft.stateIsolation}
                onDraftIsolationChange={(value) => setField("stateIsolation", value)}
                draftSessionLimit={draft.sessionLimit}
                onDraftSessionLimitChange={(value) => setField("sessionLimit", value)}
                onOpenAgent={onOpenAgent}
              />
            </div>

            <dl className="grid grid-cols-1 gap-x-6 gap-y-1.5 text-sm @lg/agent-detail:grid-cols-2">
              <div>
                <dt className="text-muted-foreground">{t("detailTimeout")}</dt>
                <dd className="min-w-0 break-all">
                  {t("milliseconds", { value: agent.timeout ?? 300000 })}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t("detailRetry")}</dt>
                <dd className="min-w-0 break-all">
                  {t("retrySummary", {
                    count: agent.retryConfig?.maxRetries ?? 3,
                    delay: agent.retryConfig?.retryDelay ?? 1000,
                  })}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t("detailBackoff")}</dt>
                <dd className="min-w-0 break-all">
                  {(agent.retryConfig?.exponentialBackoff ?? true)
                    ? t("backoffExponential")
                    : t("backoffFixed")}
                </dd>
              </div>
              {agent.process && (
                <>
                  <div>
                    <dt className="text-muted-foreground">{t("command")}</dt>
                    <dd className="min-w-0">
                      <code className="break-all rounded bg-muted px-1 text-xs">
                        {agent.process.command}
                      </code>
                    </dd>
                  </div>
                  {agent.process.cwd && (
                    <div className="@lg/agent-detail:col-span-2">
                      <dt className="text-muted-foreground">{t("workingDirectory")}</dt>
                      <dd className="min-w-0">
                        <code className="break-all rounded bg-muted px-1 text-xs">
                          {agent.process.cwd}
                        </code>
                      </dd>
                    </div>
                  )}
                </>
              )}
              {agent.network?.endpoint && (
                <div className="@lg/agent-detail:col-span-2">
                  <dt className="text-muted-foreground">{t("endpoint")}</dt>
                  <dd className="min-w-0">
                    <code className="break-all rounded bg-muted px-1 text-xs">
                      {agent.network.endpoint}
                    </code>
                  </dd>
                </div>
              )}
              {ecosystem?.adapterName && (
                <div>
                  <dt className="text-muted-foreground">{t("detailsAdapter")}</dt>
                  <dd className="min-w-0 break-all">{ecosystem.adapterName}</dd>
                </div>
              )}
              {ecosystem?.surfaceName && (
                <div>
                  <dt className="text-muted-foreground">{t("detailsSurface")}</dt>
                  <dd className="min-w-0 break-all">{ecosystem.surfaceName}</dd>
                </div>
              )}
              {/* Support tier is already a badge in the header — not repeated here. */}
              {ecosystem?.prerequisiteStatus && (
                <div>
                  <dt className="text-muted-foreground">{t("detailsPrerequisiteStatus")}</dt>
                  <dd className="min-w-0 break-all">{tPrereq(ecosystem.prerequisiteStatus)}</dd>
                </div>
              )}
              {ecosystem?.docsUrl && (
                <div className="@lg/agent-detail:col-span-2">
                  <dt className="text-muted-foreground">{t("detailsOfficialDocs")}</dt>
                  <dd>
                    <a
                      href={ecosystem.docsUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                      {t("detailsDocsLink")}
                    </a>
                  </dd>
                </div>
              )}
              {ecosystem?.limitationNote && (
                <div className="@lg/agent-detail:col-span-2">
                  <dt className="text-muted-foreground">{t("detailsLimitation")}</dt>
                  <dd className="min-w-0 break-all">{ecosystem.limitationNote}</dd>
                </div>
              )}
              {recommendedActions.length ? (
                <div className="@lg/agent-detail:col-span-2">
                  <dt className="text-muted-foreground">{t("detailsRecommendedActions")}</dt>
                  <dd>
                    <ul className="mt-1 ml-4 list-disc space-y-0.5">
                      {recommendedActions.map((action, index) => (
                        <li key={index}>{action}</li>
                      ))}
                    </ul>
                  </dd>
                </div>
              ) : null}
            </dl>

            {/* Native Codex app-server status (MCP servers + skills) */}
            {isCodexAppServerProtocol(agent.protocol) && (
              <CodexAppServerStatusCard agentId={agent.id} connected={isConnected} />
            )}

            {/* OpenCode server status (project / providers / agents / MCP / LSP) */}
            {(agent.protocol === "opencode" || agent.protocol === "opencode-v2") && (
              <OpencodeStatusCard agentId={agent.id} connected={isConnected} />
            )}

            {/* Pi native RPC: which providers Pi can actually authenticate (ADR-0119). */}
            {agent.protocol === "pi-rpc" && (
              <PiAuthStatusCard agentId={agent.id} connected={isConnected} />
            )}
            {presetId === "kimi" && agent.protocol === "acp" && (
              <KimiManagementCard agent={agent} />
            )}
          </SettingsStack>
        </TabsContent>

        {/* Connection — the transport fields, editable inline. Only the
            transport in use renders: stdio shows command/args/cwd, network
            transports show endpoint + key. Protocol-specific options (Codex
            sandbox, OpenCode spawn, Pi policy) stay in the editor dialog. */}
        <TabsContent value="connection" className="mt-3">
          <SettingsStack>
            {agent.transport === "stdio" ? (
              <>
                <SettingsField
                  stacked
                  htmlFor={`inspector-command-${agent.id}`}
                  label={t("command")}
                >
                  <Input
                    id={`inspector-command-${agent.id}`}
                    value={draft.processCommand}
                    onChange={(e) => setField("processCommand", e.target.value)}
                    data-testid="inspector-command"
                  />
                </SettingsField>
                <SettingsField
                  stacked
                  htmlFor={`inspector-args-${agent.id}`}
                  label={t("arguments")}
                >
                  <Input
                    id={`inspector-args-${agent.id}`}
                    value={draft.processArgs}
                    onChange={(e) => setField("processArgs", e.target.value)}
                    data-testid="inspector-args"
                  />
                </SettingsField>
                <SettingsField
                  stacked
                  htmlFor={`inspector-cwd-${agent.id}`}
                  label={t("workingDirectory")}
                >
                  <Input
                    id={`inspector-cwd-${agent.id}`}
                    value={draft.processCwd}
                    onChange={(e) => setField("processCwd", e.target.value)}
                    placeholder={t("cwdPlaceholder")}
                  />
                </SettingsField>
              </>
            ) : (
              <>
                <SettingsField
                  stacked
                  htmlFor={`inspector-endpoint-${agent.id}`}
                  label={t("endpoint")}
                >
                  <Input
                    id={`inspector-endpoint-${agent.id}`}
                    value={draft.networkEndpoint}
                    onChange={(e) => setField("networkEndpoint", e.target.value)}
                    data-testid="inspector-endpoint"
                  />
                </SettingsField>
                <SettingsField stacked htmlFor={`inspector-apikey-${agent.id}`} label={t("apiKey")}>
                  <Input
                    id={`inspector-apikey-${agent.id}`}
                    type="password"
                    value={draft.networkApiKey}
                    onChange={(e) => setField("networkApiKey", e.target.value)}
                    placeholder={t("apiKeyPlaceholder")}
                    aria-describedby={agent.credentialRefs?.apiKey ? `${ids}-key-saved` : undefined}
                  />
                  {agent.credentialRefs?.apiKey ? (
                    <p
                      id={`${ids}-key-saved`}
                      className="text-xs text-muted-foreground"
                      data-testid="inspector-key-saved"
                    >
                      {t("inspectorKeySaved")}
                    </p>
                  ) : null}
                </SettingsField>
              </>
            )}
          </SettingsStack>
        </TabsContent>

        <TabsContent value="advanced" className="mt-3">
          <SettingsStack>
            <div className="grid grid-cols-1 gap-3 @md/agent-detail:grid-cols-2">
              <SettingsField
                stacked
                htmlFor={`inspector-timeout-${agent.id}`}
                label={t("executionTimeoutMs")}
              >
                <Input
                  id={`inspector-timeout-${agent.id}`}
                  type="number"
                  min={1000}
                  step={1000}
                  value={draft.timeoutMs}
                  onChange={(e) => setField("timeoutMs", e.target.value)}
                  data-testid="inspector-timeout"
                />
              </SettingsField>
              <SettingsField
                stacked
                htmlFor={`inspector-retries-${agent.id}`}
                label={t("maxRetries")}
              >
                <Input
                  id={`inspector-retries-${agent.id}`}
                  type="number"
                  min={0}
                  step={1}
                  value={draft.retryMaxRetries}
                  onChange={(e) => setField("retryMaxRetries", e.target.value)}
                />
              </SettingsField>
              <SettingsField
                stacked
                htmlFor={`inspector-retry-delay-${agent.id}`}
                label={t("retryDelayMs")}
              >
                <Input
                  id={`inspector-retry-delay-${agent.id}`}
                  type="number"
                  min={0}
                  step={100}
                  value={draft.retryDelayMs}
                  onChange={(e) => setField("retryDelayMs", e.target.value)}
                />
              </SettingsField>
              <SettingsField
                stacked
                htmlFor={`inspector-retry-max-${agent.id}`}
                label={t("maxRetryDelayMs")}
              >
                <Input
                  id={`inspector-retry-max-${agent.id}`}
                  type="number"
                  min={0}
                  step={100}
                  value={draft.retryMaxDelayMs}
                  onChange={(e) => setField("retryMaxDelayMs", e.target.value)}
                />
              </SettingsField>
            </div>
            <SettingsField stacked htmlFor={`${ids}-backoff`} label={t("backoffStrategy")}>
              <Select
                value={draft.retryExponentialBackoff ? "true" : "false"}
                onValueChange={(value) => setField("retryExponentialBackoff", value === "true")}
              >
                <SelectTrigger id={`${ids}-backoff`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="true">{t("backoffExponential")}</SelectItem>
                  <SelectItem value="false">{t("backoffFixedDelay")}</SelectItem>
                </SelectContent>
              </Select>
            </SettingsField>
            <SettingsField stacked htmlFor={`${ids}-permission`} label={t("defaultPermissionMode")}>
              <Select
                value={
                  adaptPermissionMode(agent.defaultPermissionMode ?? "default", agent.protocol).mode
                }
                onValueChange={(v) => {
                  void applyInstantUpdate({ defaultPermissionMode: v as AcpPermissionMode })
                }}
              >
                <SelectTrigger id={`${ids}-permission`} data-testid="inspector-permission-mode">
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
            </SettingsField>
            {/* Whether the binary reaches the web on its own — a property of
              what the user installed, not the wire protocol. */}
            <SettingsField stacked htmlFor={`${ids}-web-search`} label={t("declaredWebSearch")}>
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
                  void applyInstantUpdate({ declaredCapabilities: caps })
                }}
              >
                <SelectTrigger id={`${ids}-web-search`} data-testid="inspector-declared-web-search">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">{t("declaredWebSearchAuto")}</SelectItem>
                  <SelectItem value="native">{t("declaredWebSearchNative")}</SelectItem>
                  <SelectItem value="unsupported">{t("declaredWebSearchNone")}</SelectItem>
                </SelectContent>
              </Select>
            </SettingsField>

            {agent.protocol === "acp" && (
              <AcpFeatureSettings agent={agent} applyUpdate={applyInstantUpdate} />
            )}

            {agent.metadata?.providerUndoWarningAcknowledged === true && (
              <SettingsBlock
                title={t("providerUndoWarningSetting")}
                description={t("providerUndoWarningSettingDescription")}
              >
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    void applyInstantUpdate({
                      metadata: { providerUndoWarningAcknowledged: false },
                    })
                  }}
                  data-testid="reset-provider-undo-warning"
                >
                  {t("providerUndoWarningReset")}
                </Button>
              </SettingsBlock>
            )}
          </SettingsStack>
        </TabsContent>
      </Tabs>

      {/* One dirty bar for the whole draft — the fields it saves span the
          Connection and Advanced tabs. */}
      {dirtyBar}
    </div>
  )
}
