"use client"

/**
 * ExternalAgentSettings — list/detail layout on `SettingsListDetail`.
 *
 * Landing view is the "All agents" board (fleet rollup + per-agent next
 * action) rather than the preset store. The left rail is a searchable list of
 * agents grouped by readiness (problems sort to the top) or by runtime, so the
 * several configurations a user keeps of one runtime sit together and each row
 * says what sets it apart (ADR-0216). It is followed by the CONFIGURE
 * destinations (global settings, routing, runtimes, host).
 * Selecting an agent opens the inspector in the bordered detail pane: header
 * actions, the full readiness strip, and tabs with inline editing for the
 * common fields. The editor dialog remains the deep editor for
 * protocol-specific options.
 *
 * At the stacked pane tier the list and the detail take turns owning the pane
 * (`ExternalAgentRail` renders the back bar); the detail pane below steps
 * aside while the list is on screen.
 */

import Link from "next/link"
import {
  useState,
  useCallback,
  useMemo,
  useId,
  useRef,
  useEffect,
  type RefObject,
  type ComponentProps,
} from "react"
import { useTranslations } from "next-intl"
import { useRouter } from "next/navigation"
import { ExternalLink, Plus, Smartphone } from "lucide-react"

import { lifecycleErrorMessage } from "@/lib/ai/agent/external/lifecycle/error-messages"
import { getExternalAgentLifecycleService } from "@/lib/ai/agent/external/lifecycle/service"
import { externalAgentSandboxSupportsPlatform } from "@/lib/ai/agent/external/policy/security-policy"
import { computeAgentReadiness } from "@/lib/ai/agent/external/agent-readiness"
import { getExternalAgentExecutionBlockReason } from "@/lib/ai/agent/external/config/config-normalizer"
import {
  distinguishingTraits,
  runtimeSiblings,
} from "@/lib/ai/agent/external/config/instance-family"
import { PROCESS_PLANE_COMMANDS } from "@/lib/ai/agent/external/capability/process-plane"
import { useExternalAgentProcessPlane } from "@/hooks/agent/use-external-agent-process-plane"
import { RuntimeGovernancePanel } from "@/components/agent/external-agent/runtime-governance-panel"
import type { InstanceTrait } from "@/components/agent/external-agent/instance-traits"
import { EXTERNAL_AGENTS_ROUTE } from "@/components/mobile/external-agents/routes"
import { HostExternalAgentConfigs } from "./host-external-agent-configs"
import { isTauri } from "@/lib/tauri"
import { isNativeMobile } from "@/lib/platform/detect"
import { platform as tauriPlatform } from "@tauri-apps/plugin-os"
import { cn } from "@/lib/utils"
import { toast } from "@/components/ui/sonner"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import {
  SettingsStack,
  SettingsBlock,
  SettingsField,
} from "@/components/settings/common/settings-block"
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
import {
  SettingsListDetail,
  listDensityForWidth,
  useSettingsListDensity,
} from "@/components/settings/common/settings-master-detail"
import { DeepSeekHarnessCard } from "./deepseek-harness-card"
import { AgentEditorDialog, type AgentEditorSaveInput } from "./agent-editor-dialog"
import { AddAgentDialog } from "./add-agent-dialog"
import {
  ExternalAgentRail,
  type AgentRailStackedView,
  type AgentSettingsView,
  type AgentStateFilter,
} from "./external-agent-rail"
import { AgentOverviewBoard } from "./agent-overview-board"
import { describeExternalAgentFailure } from "@/lib/ai/agent/external/agent-failure"
import { useElementWidth } from "@/hooks/use-element-width"
import { AgentInspector } from "./agent-inspector"
import { AgentMobileDetail } from "./agent-mobile-detail"
import { DuplicateAgentDialog } from "./duplicate-agent-dialog"
import type { AgentReadinessAction } from "@/lib/ai/agent/external/agent-readiness"
import type { CreateExternalAgentInput } from "@/types/agent/external-agent"
import type { ExternalAgentDuplicateOptions } from "@/lib/ai/agent/external/config/duplicate-config"

/** Focus follows the pane only when stacked navigation changes its contents. */
function AgentPaneFocus({
  paneRef,
  view,
  stackedView,
}: {
  paneRef: RefObject<HTMLDivElement | null>
  view: AgentSettingsView
  stackedView: AgentRailStackedView
}) {
  const density = useSettingsListDensity()
  const destination =
    view.kind === "agent"
      ? `agent-row-${view.id}`
      : {
          overview: "nav-all-agents",
          global: "nav-global-settings",
          delegation: "nav-delegation",
          runtimes: "nav-runtimes",
          host: "nav-host-configs",
        }[view.kind]
  const previous = useRef({ density, stackedView, destination })
  useEffect(() => {
    const before = previous.current
    previous.current = { density, stackedView, destination }
    if (
      density !== "stacked" ||
      (before.density === density &&
        before.stackedView === stackedView &&
        before.destination === destination)
    )
      return
    // Let a closing discard dialog restore its focus before handing it to the pane.
    const frame = requestAnimationFrame(() => {
      const pane = paneRef.current
      const target =
        stackedView === "detail"
          ? pane?.querySelector<HTMLElement>("[data-detail-heading]")
          : (Array.from(pane?.querySelectorAll<HTMLElement>("[data-testid]") ?? []).find(
              (element) => element.dataset.testid === destination
            ) ?? pane?.querySelector<HTMLElement>('[data-testid="nav-all-agents"]'))
      target?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [density, destination, paneRef, stackedView])
  return null
}

/**
 * The detail half of the list/detail frame. At the stacked tier it steps
 * aside while the list owns the pane; the density is only readable inside
 * `SettingsListDetail`, which is why this is its own component.
 */
function AgentDetailSlot({
  stackedView,
  children,
}: {
  stackedView: AgentRailStackedView
  children: React.ReactNode
}) {
  const density = useSettingsListDensity()
  if (density === "stacked" && stackedView === "list") return null
  return (
    <section
      className="flex min-h-0 min-w-0 flex-col overflow-hidden"
      data-testid="agent-detail-slot"
    >
      {children}
    </section>
  )
}

/** The stacked detail owns its per-item drafts; only the split inspector has a frame. */
function AgentDetail(props: ComponentProps<typeof AgentInspector>) {
  const density = useSettingsListDensity()
  if (density === "stacked") {
    return (
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <AgentMobileDetail {...props} onDirtyChange={undefined} />
      </div>
    )
  }
  return (
    <div
      className="@container/agent-detail flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border bg-card"
      data-testid="agent-inspector-frame"
    >
      <div className="min-h-0 flex-1 overflow-y-auto p-3 @md/agent-detail:p-4">
        <AgentInspector {...props} />
      </div>
    </div>
  )
}

export function ExternalAgentSettings() {
  const router = useRouter()
  const t = useTranslations("externalAgent.settings")
  const tCommon = useTranslations("common")
  const tErrors = useTranslations("externalAgent.lifecycleErrors")
  const tRail = useTranslations("externalAgent.rail")
  const controlId = useId()
  const paneRef = useRef<HTMLDivElement>(null)
  const density = listDensityForWidth(useElementWidth(paneRef), 720)

  // Store — the full subscription is deliberate: connection status and the
  // runtime validity snapshots change without touching the agent records, and
  // every readiness projection here must re-render on either.
  const {
    getAllAgents,
    getAgent,
    getConnectionStatus,
    getAgentValidity,
    recordAgentFailure,
    defaultPermissionMode,
    setDefaultPermissionMode,
    autoConnectOnStartup,
    setAutoConnectOnStartup,
    showConnectionNotifications,
    setShowConnectionNotifications,
    chatFailurePolicy,
    setChatFailurePolicy,
    agentFailures,
    railGroupBy,
    setRailGroupBy,
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
  // A phone runs nothing itself: its agents are the paired Host's, managed on
  // their own screen. This page edits only what the phone's own store holds.
  const onNativeMobile = useMemo(() => isNativeMobile(), [])

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
  const [addOpen, setAddOpen] = useState(false)
  const [stateFilter, setStateFilter] = useState<AgentStateFilter>("all")
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null)
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null)
  const [duplicateSourceId, setDuplicateSourceId] = useState<string | null>(null)
  // Master/detail selection. The fleet overview is the landing view.
  const [view, setView] = useState<AgentSettingsView>({ kind: "overview" })
  // At the stacked tier the list shows first; choosing anything hands the
  // pane to its detail. Ignored at the split tier.
  const [stackedView, setStackedView] = useState<AgentRailStackedView>("list")
  const selectedAgentId = view.kind === "agent" ? view.id : null
  const inspectorDirty = useRef(false)
  const [pendingNavigation, setPendingNavigation] = useState<(() => void) | null>(null)
  const [previousDensity, setPreviousDensity] = useState(density)
  if (previousDensity !== density) {
    setPreviousDensity(density)
    if (density === "stacked") setPendingNavigation(null)
  }
  const onInspectorDirtyChange = useCallback((dirty: boolean) => {
    inspectorDirty.current = dirty
  }, [])
  const navigate = useCallback(
    (proceed: () => void) => {
      if (density === "split" && inspectorDirty.current) setPendingNavigation(() => proceed)
      else proceed()
    },
    [density]
  )
  useEffect(() => {
    if (density === "stacked") inspectorDirty.current = false
  }, [density])
  const openView = useCallback(
    (next: AgentSettingsView) => {
      const proceed = () => {
        setView(next)
        setStackedView("detail")
      }
      if (view.kind === "agent" && next.kind === "agent" && view.id === next.id) proceed()
      else navigate(proceed)
    },
    [navigate, view]
  )
  const changeStackedView = useCallback(
    (next: AgentRailStackedView) => {
      if (next === "list") navigate(() => setStackedView("list"))
      else setStackedView(next)
    },
    [navigate]
  )
  // Both picker entry points seed the same create editor.
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

  // What sets each agent apart from the other configurations of its runtime.
  // Empty for an agent alone in its runtime: there is nothing to tell apart.
  const traitsById = new Map<string, InstanceTrait[]>(
    agents.map((agent) => [agent.id, distinguishingTraits(agent, runtimeSiblings(agent, agents))])
  )

  const openEditorForNew = useCallback((presetId = "") => {
    setAddOpen(false)
    setEditingAgentId(null)
    setSelectedPresetForNew(presetId === "custom" ? "" : presetId)
    setEditorOpen(true)
  }, [])

  const openAddDialog = useCallback(() => setAddOpen(true), [])

  // Handlers
  //
  // Every mutation goes through the lifecycle service rather than the store.
  // Writing to the store directly persisted the change and left the runtime
  // manager holding the old state: an agent added here was not registered
  // until the next app restart, an edit left the previous configuration
  // connected, and a delete could leave the child process running.
  //
  // The editor awaits these and stays open (with the user's input) on `false`.
  const handleAddAgent = useCallback(
    async (data: AgentEditorSaveInput): Promise<boolean> => {
      // `null` means "clear the saved value", which only an edit can mean; a
      // new configuration simply has no limit.
      const { maxConcurrentSessions, sessionIdleTimeout, modelRoles, ...rest } = data
      const input: CreateExternalAgentInput = {
        ...rest,
        maxConcurrentSessions: maxConcurrentSessions ?? undefined,
        sessionIdleTimeout: sessionIdleTimeout ?? undefined,
        modelRoles: modelRoles ?? undefined,
      }
      try {
        const lifecycle = await getExternalAgentLifecycleService()
        const id = await lifecycle.createConfig(input)
        toast.success(t("agentAdded"))
        // Land on what was just made, not wherever the list happened to be.
        openView({ kind: "agent", id })
        return true
      } catch (error) {
        toast.error(lifecycleErrorMessage(error, tErrors))
        return false
      }
    },
    [openView, t, tErrors]
  )

  const handleEditAgent = useCallback((agentId: string) => {
    setEditingAgentId(agentId)
    setEditorOpen(true)
  }, [])

  const handleUpdateAgent = useCallback(
    async (data: AgentEditorSaveInput): Promise<boolean> => {
      const agentId = editingAgentId
      if (!agentId) return false
      try {
        const lifecycle = await getExternalAgentLifecycleService()
        await lifecycle.updateConfig(agentId, data)
        toast.success(t("agentUpdated"))
        return true
      } catch (error) {
        toast.error(lifecycleErrorMessage(error, tErrors))
        return false
      }
    },
    [editingAgentId, t, tErrors]
  )

  const handleDuplicateAgent = useCallback(
    async (agentId: string, options: ExternalAgentDuplicateOptions): Promise<boolean> => {
      try {
        const lifecycle = await getExternalAgentLifecycleService()
        const copyId = await lifecycle.duplicateConfig(agentId, options)
        toast.success(t("agentDuplicated"))
        openView({ kind: "agent", id: copyId })
        return true
      } catch (error) {
        toast.error(lifecycleErrorMessage(error, tErrors))
        return false
      }
    },
    [openView, t, tErrors]
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
      if (selectedAgentId === agentId) {
        inspectorDirty.current = false
        setPendingNavigation(null)
      }
      setView((v) => (v.kind === "agent" && v.id === agentId ? { kind: "overview" } : v))
    } catch (error) {
      toast.error(lifecycleErrorMessage(error, tErrors))
    }
  }, [deleteConfirmId, selectedAgentId, t, tErrors])

  const handleConnect = useCallback(
    async (agentId: string) => {
      let delegated = false
      try {
        const agent = getAgent(agentId)
        if (!agent) {
          throw new Error(t("agentNotFound"))
        }
        const runtimeValidity = getAgentValidity(agentId)
        const blockedReason =
          (runtimeValidity?.executable === false ? runtimeValidity.blockingReason : null) ??
          getExternalAgentExecutionBlockReason(agent)
        if (blockedReason) {
          throw new Error(blockedReason)
        }
        delegated = true
        await connect(agentId)
        toast.success(t("connected"))
      } catch (error) {
        // The hook owns failures once connect starts; only preflight failures
        // need recording here.
        if (!delegated) recordAgentFailure(describeExternalAgentFailure(agentId, "connect", error))
        toast.error(t("connectionFailed"), {
          description: (error as Error).message,
        })
      }
    },
    [connect, t, getAgent, getAgentValidity, recordAgentFailure]
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

  const setAgentEnabled = useCallback(
    async (agentId: string, next: boolean) => {
      try {
        const lifecycle = await getExternalAgentLifecycleService()
        await lifecycle.updateConfig(agentId, { enabled: next })
        toast.success(t("agentUpdated"))
      } catch (error) {
        toast.error(lifecycleErrorMessage(error, tErrors))
      }
    },
    [t, tErrors]
  )

  // The readiness model's one suggested step, run from the overview row or the
  // inspector strip: enable → lifecycle update, inspect → editor dialog,
  // retry/connect → connect, add-rule → the delegation panel.
  const runReadinessAction = useCallback(
    async (agentId: string, action: AgentReadinessAction) => {
      switch (action) {
        case "enable":
          await setAgentEnabled(agentId, true)
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
          openView({ kind: "delegation" })
          break
      }
    },
    [handleConnect, handleEditAgent, openView, setAgentEnabled]
  )

  // The delete handler already routes back to the overview; this lookup only
  // resolves a still-existing agent, so a removed id renders nothing rather
  // than a stale inspector.
  const selectedAgent = selectedAgentId
    ? agents.find((agent) => agent.id === selectedAgentId)
    : undefined
  const deleteTarget = deleteConfirmId ? getAgent(deleteConfirmId) : undefined
  const duplicateSource = duplicateSourceId ? getAgent(duplicateSourceId) : undefined

  return (
    <div
      ref={paneRef}
      className="@container/agents-page flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden"
    >
      {/* Section header — the same compact shape the other agent sections
          use (small muted icon, tracking-tight title, one-line description);
          the add action sits on the right. */}
      {density === "split" || stackedView === "list" ? (
        <div className="flex shrink-0 flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 flex-1 items-start gap-2.5 @[560px]/agents-page:basis-64">
            <ExternalLink aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 space-y-0.5">
              <h2 className="text-base font-semibold tracking-tight">{t("title")}</h2>
              <p className="hidden text-xs text-pretty text-muted-foreground @[560px]/agents-page:block">
                {t("description")}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <Button
              size="sm"
              data-testid="add-agent-button"
              onClick={openAddDialog}
              aria-label={t("addAgent")}
              className="size-8 shrink-0 p-0 @[560px]/agents-page:h-8 @[560px]/agents-page:w-auto @[560px]/agents-page:px-3"
            >
              <Plus aria-hidden className="size-4" />
              <span className="hidden @[560px]/agents-page:inline">{t("addAgent")}</span>
            </Button>
          </div>
        </div>
      ) : null}

      {onNativeMobile ? (
        <div
          className="mt-3 flex shrink-0 flex-wrap items-center gap-2 rounded-md border bg-muted/30 px-3 py-2 text-xs"
          data-testid="external-agent-mobile-notice"
        >
          <Smartphone aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 basis-48">{t("mobileHostNotice")}</span>
          <Button asChild size="sm" variant="outline" className="touch-target">
            <Link href={EXTERNAL_AGENTS_ROUTE}>{t("mobileHostNoticeAction")}</Link>
          </Button>
        </div>
      ) : null}

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

      {/* The phone's bottom tab bar floats over the end of the page, so the
          last row needs room to scroll clear of it. Viewport-gated on purpose:
          the tab bar itself is a viewport decision, not a pane one. With the
          header stepped aside, nothing sits above the back bar to space from. */}
      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col max-md:pb-[calc(6rem+env(safe-area-inset-bottom))]",
          density === "split" || stackedView === "list" ? "pt-4" : "pt-0"
        )}
      >
        <SettingsListDetail
          listWidth={240}
          splitAt={720}
          className="min-h-0 flex-1"
          data-testid="agents-list-detail"
        >
          <AgentPaneFocus paneRef={paneRef} view={view} stackedView={stackedView} />
          <ExternalAgentRail
            agents={agents}
            readinessById={readinessById}
            traitsById={traitsById}
            view={view}
            groupBy={railGroupBy}
            onGroupByChange={setRailGroupBy}
            stateFilter={stateFilter}
            onStateFilterChange={setStateFilter}
            stackedView={stackedView}
            onStackedViewChange={changeStackedView}
            onViewChange={openView}
            onNewAgent={openAddDialog}
            onConnect={(id) => void handleConnect(id)}
            onDisconnect={(id) => void handleDisconnect(id)}
            isConnecting={isConnecting}
          />

          {/* Detail pane — split views share the bordered frame; the
              configure destinations use flat settings blocks inside. The container
              is the DETAIL column, so the inspector's layout follows the room
              it actually has, not the rail and detail together. */}
          <AgentDetailSlot stackedView={stackedView}>
            {view.kind === "agent" && selectedAgent ? (
              <AgentDetail
                key={selectedAgent.id}
                onDirtyChange={onInspectorDirtyChange}
                agent={selectedAgent}
                allAgents={agents}
                readiness={readinessById.get(selectedAgent.id)!}
                isConnecting={isConnecting(selectedAgent.id)}
                onOpenRuntimes={() => openView({ kind: "runtimes" })}
                onOpenPlugins={() => navigate(() => router.push("/plugins"))}
                onConnect={() => handleConnect(selectedAgent.id)}
                onDisconnect={() => handleDisconnect(selectedAgent.id)}
                onEdit={() => handleEditAgent(selectedAgent.id)}
                onDuplicate={() => setDuplicateSourceId(selectedAgent.id)}
                onDelete={() => setDeleteConfirmId(selectedAgent.id)}
                onOpenAgent={(id) => openView({ kind: "agent", id })}
                onAddRule={() => {
                  setDelegationSeed({ agentId: selectedAgent.id })
                  openView({ kind: "delegation" })
                }}
              />
            ) : (
              <div
                data-detail-density={density}
                className={cn(
                  "@container/agent-detail min-h-0 flex-1 overflow-y-auto",
                  density === "split" ? "rounded-lg border p-4" : "pr-0.5"
                )}
              >
                {view.kind === "overview" && (
                  <AgentOverviewBoard
                    entries={agents.map((agent) => ({
                      agent,
                      readiness: readinessById.get(agent.id)!,
                      traits: traitsById.get(agent.id) ?? [],
                      failureHeadline: agentFailures[agent.id]?.message,
                    }))}
                    stateFilter={stateFilter}
                    onStateFilterChange={setStateFilter}
                    onOpenAgent={(id) => openView({ kind: "agent", id })}
                    onAction={(id, action) => void runReadinessAction(id, action)}
                    onPickPreset={openEditorForNew}
                  />
                )}

                {view.kind === "delegation" && (
                  <div className="space-y-4">
                    <DelegationRulesSection
                      createForAgent={delegationSeed}
                      onAddAgent={openAddDialog}
                      onOpenAgent={(id) => openView({ kind: "agent", id })}
                    />
                  </div>
                )}

                {/* The catalog, the version probe and the certification policy all
                existed with no caller: a verdict was computed for nobody. This
                is where they surface. */}
                {view.kind === "runtimes" && (
                  <div className="space-y-4">
                    <RuntimeGovernancePanel title={tRail("runtimesAndInstalls")} />
                    <DeepSeekHarnessCard />
                  </div>
                )}

                {view.kind === "host" && (
                  <div className="space-y-4">
                    <HostExternalAgentConfigs title={tRail("hostOwnedAgents")} />
                  </div>
                )}

                {view.kind === "global" && (
                  <section data-testid="global-settings-card" className="space-y-5">
                    <header>
                      <h3
                        tabIndex={-1}
                        data-detail-heading="global"
                        className="text-base font-semibold"
                      >
                        {t("globalSettings")}
                      </h3>
                      <p className="text-sm text-muted-foreground">{t("globalSettingsDesc")}</p>
                    </header>
                    <SettingsStack className="[&_h4]:text-[11px] [&_h4]:font-medium [&_h4]:uppercase [&_h4]:tracking-wide [&_h4]:text-muted-foreground">
                      <SettingsBlock
                        title={t("sectionConnection")}
                        headingLevel={4}
                        contentClassName="space-y-0 rounded-xl bg-muted/20 p-3 [&>div]:py-3"
                      >
                        <SettingsField
                          htmlFor={`${controlId}-auto-connect`}
                          label={t("autoConnect")}
                          description={t("autoConnectDesc")}
                          className="flex-row items-center justify-between gap-4"
                        >
                          <span id={`${controlId}-auto-connect-description`} className="sr-only">
                            {t("autoConnectDesc")}
                          </span>
                          <Switch
                            id={`${controlId}-auto-connect`}
                            aria-describedby={`${controlId}-auto-connect-description`}
                            checked={autoConnectOnStartup}
                            onCheckedChange={setAutoConnectOnStartup}
                          />
                        </SettingsField>

                        <SettingsField
                          htmlFor={`${controlId}-notifications`}
                          label={t("showNotifications")}
                          description={t("showNotificationsDesc")}
                          className="flex-row items-center justify-between gap-4"
                        >
                          <span id={`${controlId}-notifications-description`} className="sr-only">
                            {t("showNotificationsDesc")}
                          </span>
                          <Switch
                            id={`${controlId}-notifications`}
                            aria-describedby={`${controlId}-notifications-description`}
                            checked={showConnectionNotifications}
                            onCheckedChange={setShowConnectionNotifications}
                          />
                        </SettingsField>
                      </SettingsBlock>
                      <SettingsBlock
                        title={t("sectionDefaults")}
                        headingLevel={4}
                        contentClassName="space-y-0 rounded-xl bg-muted/20 p-3 [&>div]:py-3"
                      >
                        <SettingsField
                          htmlFor={`${controlId}-permission`}
                          label={t("defaultPermissionMode")}
                          description={t("defaultPermissionModeDesc")}
                        >
                          <span id={`${controlId}-permission-description`} className="sr-only">
                            {t("defaultPermissionModeDesc")}
                          </span>
                          <Select
                            value={defaultPermissionMode}
                            onValueChange={(v) =>
                              setDefaultPermissionMode(
                                v as "default" | "acceptEdits" | "bypassPermissions" | "plan"
                              )
                            }
                          >
                            <SelectTrigger
                              id={`${controlId}-permission`}
                              aria-describedby={`${controlId}-permission-description`}
                              className="w-full @md/settings-stack:w-[200px]"
                            >
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
                        </SettingsField>

                        <SettingsField
                          htmlFor={`${controlId}-failure-policy`}
                          label={t("chatFailurePolicy")}
                          description={t("chatFailurePolicyDesc")}
                        >
                          <span id={`${controlId}-failure-policy-description`} className="sr-only">
                            {t("chatFailurePolicyDesc")}
                          </span>
                          <Select
                            value={chatFailurePolicy}
                            onValueChange={(value) =>
                              setChatFailurePolicy(value as "fallback" | "strict")
                            }
                          >
                            <SelectTrigger
                              id={`${controlId}-failure-policy`}
                              aria-describedby={`${controlId}-failure-policy-description`}
                              className="w-full @md/settings-stack:w-[240px]"
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="fallback">
                                {t("chatFailurePolicyFallback")}
                              </SelectItem>
                              <SelectItem value="strict">{t("chatFailurePolicyStrict")}</SelectItem>
                            </SelectContent>
                          </Select>
                        </SettingsField>
                      </SettingsBlock>
                    </SettingsStack>
                  </section>
                )}
              </div>
            )}
          </AgentDetailSlot>
        </SettingsListDetail>
      </div>

      <AddAgentDialog open={addOpen} onOpenChange={setAddOpen} onPick={openEditorForNew} />

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
        onChangePreset={
          editingAgentId
            ? undefined
            : () => {
                setEditorOpen(false)
                setAddOpen(true)
              }
        }
        onSave={editingAgentId ? handleUpdateAgent : handleAddAgent}
      />

      {duplicateSource ? (
        <DuplicateAgentDialog
          key={duplicateSource.id}
          open
          source={duplicateSource}
          existingNames={agents.map((agent) => agent.name)}
          onOpenChange={(open) => {
            if (!open) setDuplicateSourceId(null)
          }}
          onDuplicate={async (options) => {
            const ok = await handleDuplicateAgent(duplicateSource.id, options)
            if (ok) setDuplicateSourceId(null)
            return ok
          }}
        />
      ) : null}

      {/* Delete Confirmation */}
      <AlertDialog
        open={pendingNavigation !== null}
        onOpenChange={(open) => {
          if (!open) setPendingNavigation(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("discardDraftTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("discardDraftDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("keepEditing")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const proceed = pendingNavigation
                setPendingNavigation(null)
                inspectorDirty.current = false
                proceed?.()
              }}
            >
              {t("discardDraft")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={!!deleteConfirmId}
        onOpenChange={(open) => !open && setDeleteConfirmId(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {deleteTarget ? t("deleteAgentNamed", { name: deleteTarget.name }) : t("deleteAgent")}
            </AlertDialogTitle>
            <AlertDialogDescription>{t("deleteAgentConfirm")}</AlertDialogDescription>
            {deleteTarget?.stateIsolation === "isolated" && deleteTarget.transport === "stdio" ? (
              <p className="text-sm text-muted-foreground" data-testid="delete-agent-state-note">
                {t("deleteAgentStateNote")}
              </p>
            ) : null}
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
