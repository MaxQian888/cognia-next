"use client"

/**
 * ExternalAgentSettings — list/detail layout on `SettingsListDetail`.
 *
 * Landing view is the "All agents" board (fleet rollup + per-agent next
 * action) rather than the preset store. The left rail is a searchable,
 * readiness-grouped list of agents — problems sort to the top — followed by
 * the CONFIGURE destinations (global settings, delegation, quick start,
 * runtimes, host). Selecting an agent opens the inspector in the bordered
 * detail pane: header actions, the full readiness strip, and tabs with
 * inline editing for the common fields. The editor dialog remains the deep
 * editor for protocol-specific options.
 */

import { useState, useCallback, useMemo } from "react"
import { useTranslations } from "next-intl"
import { ExternalLink, Plus } from "lucide-react"

import { lifecycleErrorMessage } from "@/lib/ai/agent/external/lifecycle/error-messages"
import { getExternalAgentLifecycleService } from "@/lib/ai/agent/external/lifecycle/service"
import { externalAgentSandboxSupportsPlatform } from "@/lib/ai/agent/external/security-policy"
import { computeAgentReadiness } from "@/lib/ai/agent/external/agent-readiness"
import { getExternalAgentExecutionBlockReason } from "@/lib/ai/agent/external/config-normalizer"
import { PROCESS_PLANE_COMMANDS } from "@/lib/ai/agent/external/process-plane"
import { useExternalAgentProcessPlane } from "@/hooks/agent/use-external-agent-process-plane"
import { RuntimeGovernancePanel } from "@/components/agent/external-agent/runtime-governance-panel"
import { HostExternalAgentConfigs } from "./host-external-agent-configs"
import { isTauri } from "@/lib/tauri"
import { platform as tauriPlatform } from "@tauri-apps/plugin-os"
import { toast } from "@/components/ui/sonner"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
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
import { useExternalAgentStore, selectDelegationRules } from "@/stores/agent/external-agent-store"
import { useExternalAgent } from "@/hooks/agent/use-external-agent"
import { DelegationRulesSection } from "./delegation-rules-section"
import { SettingsListDetail } from "@/components/settings/common/settings-master-detail"
import { DeepSeekHarnessCard } from "./deepseek-harness-card"
import { AgentEditorDialog } from "./agent-editor-dialog"
import { PresetGalleryCard } from "./preset-gallery-card"
import { ExternalAgentRail, type AgentSettingsView } from "./external-agent-rail"
import { AgentOverviewBoard } from "./agent-overview-board"
import { AgentInspector } from "./agent-inspector"
import type { AgentReadinessAction } from "@/lib/ai/agent/external/agent-readiness"
import type { CreateExternalAgentInput } from "@/types/agent/external-agent"

export function ExternalAgentSettings() {
  const t = useTranslations("externalAgent.settings")
  const tCommon = useTranslations("common")
  const tErrors = useTranslations("externalAgent.lifecycleErrors")

  // Store — the full subscription is deliberate: connection status and the
  // runtime validity snapshots change without touching the agent records, and
  // every readiness projection here must re-render on either.
  const {
    getAllAgents,
    getAgent,
    getConnectionStatus,
    getAgentValidity,
    enabled,
    setEnabled,
    defaultPermissionMode,
    setDefaultPermissionMode,
    autoConnectOnStartup,
    setAutoConnectOnStartup,
    showConnectionNotifications,
    setShowConnectionNotifications,
    chatFailurePolicy,
    setChatFailurePolicy,
    overviewBannerCollapsed,
    setOverviewBannerCollapsed,
  } = useExternalAgentStore()
  const delegationRules = useExternalAgentStore(selectDelegationRules)

  // Hook for connection management
  const { connect, disconnect } = useExternalAgent()

  // Reactive process-plane reach: a paired Host finishing its handshake flips
  // "runnable" from blocked to done without any other store change. Passing
  // the verdict in keeps the readiness projection subscribed to it.
  const processPlane = useExternalAgentProcessPlane(PROCESS_PLANE_COMMANDS.spawn)

  // Platform gate. Resolved once: `isMacPlatform`-style helpers read the Tauri
  // OS plugin, which is synchronous but only meaningful on desktop — a browser
  // shell has no spawn path to sandbox and must not show the warning.
  const sandboxAvailable = useMemo(() => {
    if (!isTauri()) return true
    try {
      return externalAgentSandboxSupportsPlatform(tauriPlatform())
    } catch {
      // The OS plugin is unavailable (older shell / test env). Refusing here
      // would put a scary banner in front of users we know nothing about.
      return true
    }
  }, [])

  // Check if a specific agent is connecting
  const isConnecting = useCallback(
    (agentId: string) => {
      const status = getConnectionStatus(agentId)
      return status === "connecting" || status === "reconnecting"
    },
    [getConnectionStatus]
  )

  // Local state
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null)
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null)
  // Master/detail selection. The fleet overview is the landing view.
  const [view, setView] = useState<AgentSettingsView>({ kind: "overview" })
  const selectedAgentId = view.kind === "agent" ? view.id : null
  // Preset id seeded into the AgentEditorDialog when opening from the
  // quick-start gallery. Empty when the user opens the manual "Add agent"
  // button.
  const [selectedPresetForNew, setSelectedPresetForNew] = useState<string>("")
  // The readiness "Add routing rule" action hands the agent to the delegation
  // panel so its create dialog opens already targeted at it. A fresh object
  // per navigation means the same agent can be seeded twice in a row.
  const [delegationSeed, setDelegationSeed] = useState<{ agentId: string } | null>(null)

  // Get agents
  const agents = getAllAgents()

  // Readiness projection for every agent. Cheap (a handful of records) and
  // recomputed on render so connection-status / validity changes land
  // immediately — the inputs are store reads, not memoized snapshots.
  const readinessById = new Map(
    agents.map((agent) => [
      agent.id,
      computeAgentReadiness({
        agent,
        connectionStatus: getConnectionStatus(agent.id),
        delegatedRuleCount: delegationRules.filter(
          (rule) => rule.targetAgentId === agent.id && rule.enabled
        ).length,
        validity: getAgentValidity(agent.id) ?? agent.validitySnapshot,
        reach: processPlane,
      }),
    ])
  )

  // Handlers
  //
  // Every mutation goes through the lifecycle service rather than the store.
  // Writing to the store directly persisted the change and left the runtime
  // manager holding the old state: an agent added here was not registered
  // until the next app restart, an edit left the previous configuration
  // connected, and a delete could leave the child process running.
  const handleAddAgent = useCallback(
    async (data: CreateExternalAgentInput) => {
      try {
        const lifecycle = await getExternalAgentLifecycleService()
        await lifecycle.createConfig(data)
        toast.success(t("agentAdded"))
      } catch (error) {
        toast.error(lifecycleErrorMessage(error, tErrors))
      }
    },
    [t, tErrors]
  )

  const handleEditAgent = useCallback((agentId: string) => {
    setEditingAgentId(agentId)
    setEditorOpen(true)
  }, [])

  const handleUpdateAgent = useCallback(
    async (data: CreateExternalAgentInput) => {
      const agentId = editingAgentId
      if (!agentId) return
      try {
        const lifecycle = await getExternalAgentLifecycleService()
        await lifecycle.updateConfig(agentId, data)
        toast.success(t("agentUpdated"))
        setEditorOpen(false)
      } catch (error) {
        toast.error(lifecycleErrorMessage(error, tErrors))
      }
    },
    [editingAgentId, t, tErrors]
  )

  const handleDeleteAgent = useCallback(async () => {
    const agentId = deleteConfirmId
    setDeleteConfirmId(null)
    if (!agentId) return
    try {
      const lifecycle = await getExternalAgentLifecycleService()
      await lifecycle.removeConfig(agentId)
      toast.success(t("agentRemoved"))
      // Deleting the agent under the detail pane leaves a blank section —
      // land back on the overview instead.
      setView((v) => (v.kind === "agent" && v.id === agentId ? { kind: "overview" } : v))
    } catch (error) {
      toast.error(lifecycleErrorMessage(error, tErrors))
    }
  }, [deleteConfirmId, t, tErrors])

  const handleConnect = useCallback(
    async (agentId: string) => {
      try {
        const agent = getAgent(agentId)
        if (!agent) {
          throw new Error("Agent not found")
        }
        const runtimeValidity = getAgentValidity(agentId)
        const blockedReason =
          (runtimeValidity?.executable === false ? runtimeValidity.blockingReason : null) ??
          getExternalAgentExecutionBlockReason(agent)
        if (blockedReason) {
          throw new Error(blockedReason)
        }
        await connect(agentId)
        toast.success(t("connected"))
      } catch (error) {
        toast.error(t("connectionFailed"), {
          description: (error as Error).message,
        })
      }
    },
    [connect, t, getAgent, getAgentValidity]
  )

  const handleDisconnect = useCallback(
    async (agentId: string) => {
      try {
        await disconnect(agentId)
        toast.success(t("disconnected"))
      } catch (_error) {
        toast.error(t("disconnectFailed"))
      }
    },
    [disconnect, t]
  )

  // The readiness model's one suggested step, run from the overview row or the
  // inspector strip: enable → lifecycle update, inspect → editor dialog,
  // retry/connect → connect, add-rule → the delegation panel.
  const runReadinessAction = useCallback(
    async (agentId: string, action: AgentReadinessAction) => {
      switch (action) {
        case "enable":
          try {
            const lifecycle = await getExternalAgentLifecycleService()
            await lifecycle.updateConfig(agentId, { enabled: true })
            toast.success(t("agentUpdated"))
          } catch (error) {
            toast.error(lifecycleErrorMessage(error, tErrors))
          }
          break
        case "inspect":
          handleEditAgent(agentId)
          break
        case "retry":
        case "connect":
          void handleConnect(agentId)
          break
        case "add-rule":
          setDelegationSeed({ agentId })
          setView({ kind: "delegation" })
          break
      }
    },
    [handleConnect, handleEditAgent, t, tErrors]
  )

  // The delete handler already routes back to the overview; this lookup only
  // resolves a still-existing agent, so a removed id renders nothing rather
  // than a stale inspector.
  const selectedAgent = selectedAgentId
    ? agents.find((agent) => agent.id === selectedAgentId)
    : undefined

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden">
      {/* Section header — the same compact shape the other agent sections
          use (small muted icon, tracking-tight title, one-line description);
          the master switch and add action sit on the right. */}
      <div className="flex shrink-0 flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <ExternalLink aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 space-y-0.5">
            <h2 className="text-base font-semibold tracking-tight">{t("title")}</h2>
            <p className="text-xs text-pretty text-muted-foreground">{t("description")}</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <div className="flex items-center gap-2">
            <Switch
              id="external-agents-enabled"
              checked={enabled}
              onCheckedChange={setEnabled}
              aria-label={t("enableExternalAgents")}
            />
            <Label htmlFor="external-agents-enabled" className="text-sm whitespace-nowrap">
              {t("enableExternalAgents")}
            </Label>
          </div>
          <Button
            size="sm"
            data-testid="add-agent-button"
            onClick={() => {
              setEditingAgentId(null)
              setSelectedPresetForNew("")
              setEditorOpen(true)
            }}
            disabled={!enabled}
          >
            <Plus className="mr-1 h-4 w-4" />
            {t("addAgent")}
          </Button>
        </div>
      </div>

      {/* Mandatory-sandbox notice: only shown on a desktop shell whose OS has
          no spawn sandbox (Windows today). Browser shells have no spawn path
          at all, so there is nothing to warn about. */}
      {!sandboxAvailable && (
        <p
          className="mt-3 shrink-0 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400"
          data-testid="external-agent-sandbox-unavailable"
        >
          {t("sandboxUnavailableOnPlatform")}
        </p>
      )}

      <div className="flex min-h-0 flex-1 flex-col pt-4 @container/agents-pane">
        <SettingsListDetail
          listWidth={280}
          className="min-h-0 flex-1"
          data-testid="agents-list-detail"
        >
          <ExternalAgentRail
            agents={agents}
            readinessById={readinessById}
            view={view}
            enabled={enabled}
            onViewChange={setView}
            onNewAgent={() => {
              setEditingAgentId(null)
              setSelectedPresetForNew("")
              setEditorOpen(true)
            }}
            onConnect={(id) => void handleConnect(id)}
            onDisconnect={(id) => void handleDisconnect(id)}
            isConnecting={isConnecting}
          />

          {/* Detail pane — the agent inspector gets the bordered frame; the
              card-based destinations carry their own chrome. */}
          <section className="flex min-h-0 min-w-0 flex-col overflow-hidden">
            {view.kind === "agent" && selectedAgent ? (
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border bg-card">
                <div className="min-h-0 flex-1 overflow-y-auto p-4">
                  <AgentInspector
                    key={selectedAgent.id}
                    agent={selectedAgent}
                    readiness={readinessById.get(selectedAgent.id)!}
                    isConnecting={isConnecting(selectedAgent.id)}
                    onConnect={() => handleConnect(selectedAgent.id)}
                    onDisconnect={() => handleDisconnect(selectedAgent.id)}
                    onEdit={() => handleEditAgent(selectedAgent.id)}
                    onDelete={() => setDeleteConfirmId(selectedAgent.id)}
                    onAddRule={() => {
                      setDelegationSeed({ agentId: selectedAgent.id })
                      setView({ kind: "delegation" })
                    }}
                  />
                </div>
              </div>
            ) : (
              <div className="min-h-0 flex-1 overflow-y-auto pr-0.5">
                {view.kind === "overview" && (
                  <AgentOverviewBoard
                    entries={agents.map((agent) => ({
                      agent,
                      readiness: readinessById.get(agent.id)!,
                    }))}
                    enabled={enabled}
                    bannerCollapsed={overviewBannerCollapsed}
                    onBannerCollapsedChange={setOverviewBannerCollapsed}
                    onOpenAgent={(id) => setView({ kind: "agent", id })}
                    onAction={(id, action) => void runReadinessAction(id, action)}
                    onNewAgent={() => {
                      setEditingAgentId(null)
                      setSelectedPresetForNew("")
                      setEditorOpen(true)
                    }}
                  />
                )}

                {view.kind === "delegation" && (
                  <DelegationRulesSection disabled={!enabled} createForAgent={delegationSeed} />
                )}

                {/* The catalog, the version probe and the certification policy all
                existed with no caller: a verdict was computed for nobody. This
                is where they surface. */}
                {view.kind === "runtimes" && <RuntimeGovernancePanel />}

                {view.kind === "host" && <HostExternalAgentConfigs />}

                {view.kind === "gallery" && (
                  <div className="space-y-4">
                    <PresetGalleryCard
                      disabled={!enabled}
                      onPick={(presetId) => {
                        setSelectedPresetForNew(presetId)
                        setEditingAgentId(null)
                        setEditorOpen(true)
                      }}
                    />
                    {/* Managed DeepSeek Harness installation and certification. */}
                    <DeepSeekHarnessCard />
                  </div>
                )}

                {view.kind === "global" && (
                  <Card data-testid="global-settings-card">
                    <CardHeader>
                      <CardTitle>{t("globalSettings")}</CardTitle>
                      <CardDescription>{t("globalSettingsDesc")}</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      {/* Auto Connect */}
                      <div className="flex items-center justify-between">
                        <div className="space-y-0.5">
                          <Label>{t("autoConnect")}</Label>
                          <p className="text-sm text-muted-foreground">{t("autoConnectDesc")}</p>
                        </div>
                        <Switch
                          checked={autoConnectOnStartup}
                          onCheckedChange={setAutoConnectOnStartup}
                          disabled={!enabled}
                        />
                      </div>

                      {/* Notifications */}
                      <div className="flex items-center justify-between">
                        <div className="space-y-0.5">
                          <Label>{t("showNotifications")}</Label>
                          <p className="text-sm text-muted-foreground">
                            {t("showNotificationsDesc")}
                          </p>
                        </div>
                        <Switch
                          checked={showConnectionNotifications}
                          onCheckedChange={setShowConnectionNotifications}
                          disabled={!enabled}
                        />
                      </div>

                      <Separator />

                      {/* Default Permission Mode */}
                      <div className="flex items-center justify-between">
                        <div className="space-y-0.5">
                          <Label>{t("defaultPermissionMode")}</Label>
                          <p className="text-sm text-muted-foreground">
                            {t("defaultPermissionModeDesc")}
                          </p>
                        </div>
                        <Select
                          value={defaultPermissionMode}
                          onValueChange={(v) =>
                            setDefaultPermissionMode(
                              v as "default" | "acceptEdits" | "bypassPermissions" | "plan"
                            )
                          }
                          disabled={!enabled}
                        >
                          <SelectTrigger className="w-full sm:w-[180px]">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="default">{t("permissionDefault")}</SelectItem>
                            <SelectItem value="acceptEdits">
                              {t("permissionAcceptEdits")}
                            </SelectItem>
                            <SelectItem value="bypassPermissions">
                              {t("permissionBypass")}
                            </SelectItem>
                            <SelectItem value="plan">{t("permissionPlan")}</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>

                      <Separator />

                      {/* External Failure Policy */}
                      <div className="flex items-center justify-between">
                        <div className="space-y-0.5">
                          <Label>{t("chatFailurePolicy")}</Label>
                          <p className="text-sm text-muted-foreground">
                            {t("chatFailurePolicyDesc")}
                          </p>
                        </div>
                        <Select
                          value={chatFailurePolicy}
                          onValueChange={(value) =>
                            setChatFailurePolicy(value as "fallback" | "strict")
                          }
                          disabled={!enabled}
                        >
                          <SelectTrigger className="w-full sm:w-[220px]">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="fallback">
                              {t("chatFailurePolicyFallback")}
                            </SelectItem>
                            <SelectItem value="strict">{t("chatFailurePolicyStrict")}</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </CardContent>
                  </Card>
                )}
              </div>
            )}
          </section>
        </SettingsListDetail>
      </div>

      {/* Agent Editor Dialog */}
      <AgentEditorDialog
        key={`agent-editor-${editingAgentId ?? "new"}-${selectedPresetForNew || "manual"}-${editorOpen ? "open" : "closed"}`}
        open={editorOpen}
        onOpenChange={(next) => {
          setEditorOpen(next)
          if (!next) setSelectedPresetForNew("")
        }}
        editingAgentId={editingAgentId}
        initialPreset={editingAgentId ? "" : selectedPresetForNew}
        onSave={editingAgentId ? handleUpdateAgent : handleAddAgent}
      />

      {/* Delete Confirmation */}
      <AlertDialog
        open={!!deleteConfirmId}
        onOpenChange={(open) => !open && setDeleteConfirmId(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteAgent")}</AlertDialogTitle>
            <AlertDialogDescription>{t("deleteAgentConfirm")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tCommon("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteAgent}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {tCommon("delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

export default ExternalAgentSettings
