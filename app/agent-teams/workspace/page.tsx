"use client"

/**
 * Agent Teams workspace — per-team detail page.
 *
 * Tabbed shell driven by the store's `workspaceTab`. Reads the team via
 * the existing selectors. Wires the Run / Stop buttons in the Overview
 * tab to `agentTeamManager.start` / `pause`, and the Chat tab into the
 * `dispatchTeamMention` runtime so `@<name>` actually invokes the
 * matching agent and streams its reply back into the team message log.
 *
 * Lives at `/agent-teams/workspace?teamId=…` instead of a dynamic route
 * segment so Next's static export (`output: "export"`) — required by the
 * Tauri build — does not need to enumerate runtime-created team IDs at
 * build time.
 */

import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { useTranslations } from "next-intl"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { ArrowLeftIcon } from "lucide-react"

import { mobileTransition } from "@/lib/ui/motion"

import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { cn } from "@/lib/utils"
import { toast } from "sonner"

import { useShallow } from "zustand/react/shallow"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { usePendingGatesStore } from "@/stores/agent/pending-gates-store"
import { useExternalAgentStore } from "@/stores/agent/external-agent-store"
import { useExternalAgent } from "@/hooks/agent"
import { useSettingsStore } from "@/stores/settings"
import { agentTeamManager } from "@/lib/ai/agent/agent-team"
import { abortTeam } from "@/lib/ai/agent/agent-team-runtime"
import { AgentTeamOverview } from "@/components/agent/workspace/overview"
import { AgentTeamTasks } from "@/components/agent/workspace/tasks"
import { AgentTeamChat } from "@/components/agent/workspace/chat"
import { AgentTeamActivity } from "@/components/agent/workspace/activity"
import { DurableOperations } from "@/components/agent/workspace/durable-operations"
import { spawnDefaultTerminal } from "@/lib/terminal/spawn-default"
import { WorktreesPanel } from "@/components/agent/workspace/worktrees-panel"
import { AgentTeamEditor } from "@/components/agent/workspace/editor/agent-team-editor"
import { AgentTeamMembers } from "@/components/agent/workspace/members"
import { AgentTeamSettings } from "@/components/agent/workspace/settings"
import { WorkspaceTabNav } from "@/components/agent/workspace/workspace-tab-nav"
import { WorkspaceHeader } from "@/components/agent/workspace/workspace-header"
import { countUnread } from "@/components/agent/workspace/unread"
import type { ComposerHandle } from "@/components/chat/composer"

import { parseLeadingMention } from "@/lib/agent-team/mention-parser"
import {
  buildMentionableTargets,
  findTargetById,
  targetsToCandidates,
} from "@/lib/agent-team/runtime-targets"
import { dispatchTeamMention } from "@/lib/agent-team/team-runtime-dispatcher"
import { createCompositeStreamer } from "@/lib/agent-team/runtime-streamers"
import { usePlatform } from "@/hooks/use-platform"
import { TeamWorkspaceMobile } from "@/components/mobile/agent-teams/team-workspace-mobile"
import { useRuntimeAvailability } from "@/lib/agent-team/use-runtime-availability"
import { buildConversationHistory } from "@/lib/agent-team/conversation-context"
import { buildTeamClaudeRuntimeModel } from "@/lib/agent-team/provider-model"
import type { AgentFileActivity } from "@/lib/agent-team/file-activity"
import { resolveLinkPath } from "@/lib/terminal/terminal-links"
import { deferProjectEditorOpen, openInProjectEditor } from "@/lib/files/project-editor-bridge"
import type { ProjectFileReference } from "@/lib/files/project-file-reference"
import { useProjectEditorSessionStore } from "@/stores/editor/project-editor-session-store"
import { useTerminalStore } from "@/stores/terminal/terminal-store"
import { useArtifactDockLayoutStore } from "@/stores/artifact/artifact-dock-layout-store"
import type {
  AgentTeamEvent,
  AgentTeamMessage,
  AgentTeamTask,
  TeammateRuntime,
} from "@/types/agent/agent-team"

const ALL_TABS = [
  "overview",
  "tasks",
  "chat",
  "activity",
  "operations",
  "worktrees",
  "editor",
  "members",
  "settings",
] as const
type Tab = (typeof ALL_TABS)[number]

// Stable empty slices returned by the tab-gated selectors below so
// useShallow sees the same reference while a tab is inactive.
const EMPTY_TASKS: AgentTeamTask[] = []
const EMPTY_MESSAGES: AgentTeamMessage[] = []
const EMPTY_EVENTS: AgentTeamEvent[] = []

function AgentTeamWorkspaceInner() {
  const searchParams = useSearchParams()
  const teamId = searchParams.get("teamId")
  const router = useRouter()
  const t = useTranslations("agentTeamsWorkspace")
  const tComposer = useTranslations("agentTeamsWorkspace.chat.composer")
  const reduceMotion = useReducedMotion()

  const team = useAgentTeamStore((s) => (teamId ? s.teams[teamId] : undefined))
  // Each of these selectors materialises a fresh array on every store change;
  // wrap with `useShallow` so React doesn't bail out of useSyncExternalStore's
  // snapshot caching (which would otherwise loop with "result of getSnapshot
  // should be cached").
  const teammates = useAgentTeamStore(
    useShallow((s) => Object.values(s.teammates).filter((m) => m.teamId === teamId))
  )
  // Tab-gated slices: tasks / messages / events are only materialised while
  // their tab is visible. During a live run the store receives a delta per
  // streamed token and per emitted event — without the gate every delta
  // re-rendered the whole workspace page regardless of the active tab.
  const tasks = useAgentTeamStore(
    useShallow((s) =>
      s.workspaceTab === "tasks"
        ? Object.values(s.tasks).filter((task) => task.teamId === teamId)
        : EMPTY_TASKS
    )
  )
  const messages = useAgentTeamStore(
    useShallow((s) =>
      s.workspaceTab === "chat"
        ? Object.values(s.messages).filter((m) => m.teamId === teamId)
        : EMPTY_MESSAGES
    )
  )
  const events = useAgentTeamStore(
    useShallow((s) =>
      s.workspaceTab === "activity" ? s.events.filter((e) => e.teamId === teamId) : EMPTY_EVENTS
    )
  )
  // Live tab signals. Both are SCALARS on purpose: they are read on every store
  // delta (one per streamed token during a run), and a number lets zustand bail
  // out of the re-render unless the value actually moves — unlike the slices
  // above, which materialise arrays and therefore have to stay tab-gated.
  const unreadCount = useAgentTeamStore((s) => countUnread(s.messages, teamId))
  const pendingGateCount = usePendingGatesStore(
    (s) => s.gates.filter((g) => g.teamId === teamId).length
  )
  const upsertMessage = useAgentTeamStore((s) => s.upsertMessage)
  const removeMessage = useAgentTeamStore((s) => s.removeMessage)
  const markTeamMessagesRead = useAgentTeamStore((s) => s.markTeamMessagesRead)
  const activeTab = useAgentTeamStore((s) => s.workspaceTab)
  const setWorkspaceTab = useAgentTeamStore((s) => s.setWorkspaceTab)
  const setWorkspaceTeamFromRoute = useAgentTeamStore((s) => s.setWorkspaceTeamFromRoute)
  const updateTeam = useAgentTeamStore((s) => s.updateTeam)
  const selectedEditorRoot = useProjectEditorSessionStore((s) =>
    teamId ? s.sessions[`team:${teamId}`]?.rootKey : undefined
  )
  const openTerminalPanel = useTerminalStore((s) => s.setPanelOpen)
  const openBrowserPanel = useArtifactDockLayoutStore((s) => s.openBrowser)

  const externalAgent = useExternalAgent()
  const { setActiveAgent, executeStreaming } = externalAgent

  const settings = useSettingsStore((s) => s.settings)

  const composerRef = useRef<ComposerHandle>(null)
  const [isSending, setIsSending] = useState(false)
  const activeDispatchRef = useRef<AbortController | null>(null)

  // Set workspace team route side-effect.
  useEffect(() => {
    setWorkspaceTeamFromRoute(teamId ?? null)
    return () => setWorkspaceTeamFromRoute(null)
  }, [teamId, setWorkspaceTeamFromRoute])

  // Close the unread loop. Without this the badge is a number that only ever
  // climbs. Keyed on `unreadCount` rather than just the tab so a reply landing
  // while you are already reading the thread clears too; `countUnread` excludes
  // streaming messages, so this fires once per finished reply, not per token.
  useEffect(() => {
    if (!teamId || activeTab !== "chat" || unreadCount === 0) return
    markTeamMessagesRead(teamId)
  }, [teamId, activeTab, unreadCount, markTeamMessagesRead])

  const mentionables = useMemo(() => buildMentionableTargets(teammates), [teammates])
  const availability = useRuntimeAvailability()

  const handleAgentFileActivity = useCallback(
    (activity: AgentFileActivity): void => {
      if (!teamId || useAgentTeamStore.getState().workspaceTab !== "editor") return
      const currentTeam = useAgentTeamStore.getState().teams[teamId]
      const workingDir = currentTeam?.config.workingDir
      if (!workingDir) return
      const root =
        useProjectEditorSessionStore.getState().sessions[`team:${teamId}`]?.rootKey ?? workingDir
      const absolutePath = resolveLinkPath(root, activity.path)
      openInProjectEditor(absolutePath, activity.line, activity.column)
    },
    [teamId]
  )

  const handleConversationFileOpen = useCallback(
    (target: ProjectFileReference): void => {
      deferProjectEditorOpen(target.absolutePath, target.line, target.column)
      setWorkspaceTab("editor")
    },
    [setWorkspaceTab]
  )

  const dispatchPair = useCallback(
    async (params: { targetId: string; prompt: string; rawText: string }): Promise<void> => {
      if (!teamId) return
      const target = findTargetById(mentionables, params.targetId)
      if (!target) {
        toast.error(tComposer("unknownAgent", { name: params.targetId }))
        return
      }

      const streamer = createCompositeStreamer({
        claude: { model: buildTeamClaudeRuntimeModel(settings) },
        external: {
          setActiveAgent,
          executeStreaming,
          resolveAgentId: (runtime: TeammateRuntime) => resolveExternalAgentIdByPreset(runtime),
        },
      })

      // Read the freshest message list straight off the store — the rendered
      // `messages` slice is tab-gated and may be empty when dispatching from
      // a retry while another tab is active.
      const history = buildConversationHistory(
        Object.values(useAgentTeamStore.getState().messages).filter((m) => m.teamId === teamId)
      )

      activeDispatchRef.current?.abort()
      const ac = new AbortController()
      activeDispatchRef.current = ac

      setIsSending(true)
      try {
        await dispatchTeamMention(
          {
            teamId,
            target,
            prompt: params.prompt,
            rawText: params.rawText,
            signal: ac.signal,
            history,
          },
          {
            writer: { upsertMessage },
            streamer,
            onFileActivity: handleAgentFileActivity,
          }
        )
      } catch (err) {
        toast.error(
          tComposer("sendingFailed", {
            agent: target.name,
            reason: err instanceof Error ? err.message : String(err),
          })
        )
      } finally {
        if (activeDispatchRef.current === ac) {
          activeDispatchRef.current = null
        }
        setIsSending(false)
      }
    },
    [
      teamId,
      mentionables,
      settings,
      setActiveAgent,
      executeStreaming,
      upsertMessage,
      tComposer,
      handleAgentFileActivity,
    ]
  )

  const handleSendMention = useCallback(
    async (rawText: string): Promise<void> => {
      if (!teamId) return
      const candidates = targetsToCandidates(mentionables)
      const parsed = parseLeadingMention(rawText, candidates)

      if (!parsed.matchedId) {
        if (parsed.unknownMention) {
          toast.error(
            tComposer("unknownAgent", {
              name: parsed.rawToken?.replace(/^@/, "") ?? "",
            })
          )
        } else {
          toast.info(tComposer("missingMention"))
        }
        return
      }

      const prompt = parsed.remainder.trim() || rawText.trim()
      if (!prompt) {
        toast.info(tComposer("missingPrompt"))
        return
      }

      await dispatchPair({ targetId: parsed.matchedId, prompt, rawText })
    },
    [teamId, mentionables, tComposer, dispatchPair]
  )

  const handleRetry = useCallback(
    async (params: { targetId: string; prompt: string; messageId: string }): Promise<void> => {
      const target = findTargetById(mentionables, params.targetId)
      const name = target?.name ?? "agent"
      const rawText = `@${name} ${params.prompt}`
      await dispatchPair({ targetId: params.targetId, prompt: params.prompt, rawText })
    },
    [mentionables, dispatchPair]
  )

  const handleDelete = useCallback(
    (messageId: string): void => {
      removeMessage(messageId)
    },
    [removeMessage]
  )

  const handleStopDispatch = useCallback(async () => {
    activeDispatchRef.current?.abort()
    // Best-effort: also tell any external ACP agent to cancel server-side.
    try {
      await externalAgent.cancel()
    } catch {
      /* swallow — already aborted is fine */
    }
  }, [externalAgent])

  if (!team) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <Card className="space-y-2 p-6 text-center text-sm text-muted-foreground">
          <p>{t("missing")}</p>
          <Button variant="outline" size="sm" onClick={() => router.push("/agent-teams")}>
            <ArrowLeftIcon className="mr-1 size-3" />
            {t("listTitle")}
          </Button>
        </Card>
      </div>
    )
  }

  const tab: Tab = (ALL_TABS as readonly string[]).includes(activeTab)
    ? (activeTab as Tab)
    : "overview"

  // Live-dot signal for the rail. Read straight off the store rather than
  // `useTeamLiveStatus`: that hook needs a non-null team (this component still
  // has to render the not-found card) and opens a second Dexie subscription the
  // header already owns. `deriveTeamStatus` lets a live store status win over
  // the run row anyway, so this only ever under-signals — never the reverse —
  // in the narrow case of a stale-terminal store with a run still going, which
  // the header badge already corrects. Under-signalling is the safe direction
  // for an attention cue.
  const isTeamLive = team.status === "executing" || team.status === "planning"

  // Panel cross-fade props, or nothing at all for the editor / reduced motion.
  // `initial={false}` (rather than a zero-duration transition) keeps the node
  // out of motion's animation loop entirely, which is what the pinned webview
  // needs — a compositing pass on the ancestor is enough to tear it.
  const animatePanels = !reduceMotion && tab !== "editor"
  const panelMotion = animatePanels
    ? {
        initial: { opacity: 0, y: 6 },
        animate: { opacity: 1, y: 0 },
        exit: { opacity: 0, y: -6 },
        transition: mobileTransition("fast"),
      }
    : { initial: false as const }

  // One console layout for all eight tabs: the chrome (tab rail + header) is
  // pinned and only the panel body scrolls.
  //
  // This used to be two competing models — chat and editor were full-height
  // while the other six scrolled as a whole page, which took the header with
  // them despite it being the surface that carries the live status and the run
  // controls. The editor forced the question: in CodeServer mode a native
  // webview is pinned over the pane and cannot follow DOM scroll, so it can
  // *only* work full-height. Making that the single model everywhere removes
  // the split and keeps Abort reachable on every tab.
  //
  // Chat and the editor opt out of the scroll container entirely (they manage
  // their own internal scrolling and must not be nested inside a second
  // scroller).
  const managesOwnScroll = tab === "chat" || tab === "editor"

  return (
    <SidebarProvider
      className="h-full min-h-0"
      style={{ "--sidebar-width": "14rem", "--sidebar-width-icon": "3rem" } as CSSProperties}
      data-testid="agent-team-workspace"
      data-bg-target="chat"
    >
      <WorkspaceTabNav
        value={tab}
        onValueChange={(v) => setWorkspaceTab(v as typeof activeTab)}
        onBack={() => router.push("/agent-teams")}
        teamName={team.name}
        counts={{ members: teammates.length }}
        signals={{
          chat: { count: unreadCount > 0 ? unreadCount : undefined },
          activity: { live: isTeamLive },
          overview: { live: isTeamLive },
        }}
      />

      <SidebarInset className="min-h-0 overflow-hidden" data-bg-target="chat">
        <div className="flex min-h-0 flex-1 flex-col gap-4 p-4 sm:p-6">
          <WorkspaceHeader
            team={team}
            teammates={teammates}
            pendingGateCount={pendingGateCount}
            onStart={() => void agentTeamManager.start(team.id).catch(() => undefined)}
            onStartUltracode={() =>
              void agentTeamManager.start(team.id, { ultracode: true }).catch(() => undefined)
            }
            onAbort={() => void abortTeam(team.id, new Error("user-aborted"))}
            onPause={() => void agentTeamManager.pause(team.id).catch(() => undefined)}
            onResume={() => void agentTeamManager.resume(team.id).catch(() => undefined)}
            onStop={() => void agentTeamManager.shutdown(team.id).catch(() => undefined)}
          />

          <div
            className={cn(
              "min-h-0 flex-1",
              // Chat and the editor need a flex column so their `flex-1` bodies
              // can claim the remaining height. The other six are plain scroll
              // blocks — nesting them in a flex column risks a tall panel being
              // shrunk instead of scrolled.
              managesOwnScroll ? "flex flex-col" : "overflow-y-auto"
            )}
            data-testid="workspace-panel-scroll"
          >
            {/* Cross-fade between panels. `mode="wait"` so the outgoing panel is
                gone before the incoming one measures — overlapping them makes
                the scroll container jump.

                The editor is deliberately excluded: in CodeServer mode a native
                webview is pinned over the pane and cannot be composited with an
                animating ancestor, which is also why globals.css force-collapses
                every transition under `html[data-pro-ide-active]`. Animating into
                it would tear. `panelMotion` therefore resolves to a no-op for
                that tab (and under reduced motion). */}
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={tab}
                className={cn("min-h-0", managesOwnScroll && "flex flex-1 flex-col")}
                {...panelMotion}
              >
                {tab === "overview" && (
                  <AgentTeamOverview
                    team={team}
                    teammates={teammates}
                    chrome="header"
                    onUpdateTeam={(updates) => {
                      updateTeam(team.id, updates)
                      toast.success(t("teamUpdated"))
                    }}
                  />
                )}
                {tab === "tasks" && (
                  <AgentTeamTasks teamId={team.id} tasks={tasks} teammates={teammates} />
                )}
                {tab === "chat" && (
                  <AgentTeamChat
                    ref={composerRef}
                    className="min-h-0 flex-1"
                    teamId={team.id}
                    messages={messages}
                    mentionables={mentionables}
                    onSend={handleSendMention}
                    onStop={handleStopDispatch}
                    isSending={isSending}
                    availability={availability}
                    onRetry={handleRetry}
                    onDelete={handleDelete}
                    projectRoot={selectedEditorRoot ?? team.config.workingDir}
                    onOpenProjectFile={handleConversationFileOpen}
                  />
                )}
                {tab === "activity" && (
                  <AgentTeamActivity
                    events={events}
                    report={team.executionReport}
                    team={team}
                    teammates={teammates}
                  />
                )}
                {tab === "operations" && (
                  <DurableOperations
                    team={team}
                    onOpenEditor={() => setWorkspaceTab("editor")}
                    onOpenTerminal={(workspacePath) => {
                      openTerminalPanel(true)
                      void spawnDefaultTerminal({
                        projectId: team.projectId ?? null,
                        ...(workspacePath ? { cwdOverride: workspacePath } : {}),
                      }).then((outcome) => {
                        if (outcome.kind === "error") toast.error(outcome.message)
                      })
                    }}
                    onOpenBrowser={openBrowserPanel}
                    onMigrate={(config) => {
                      updateTeam(team.id, { config })
                      toast.success(t("operations.migration.migrated"))
                    }}
                  />
                )}
                {tab === "worktrees" && <WorktreesPanel team={team} />}
                {tab === "editor" && <AgentTeamEditor team={team} />}
                {tab === "members" && (
                  <AgentTeamMembers team={team} teammates={teammates} leadId={team.leadId} />
                )}
                {tab === "settings" && <AgentTeamSettings team={team} />}
              </motion.div>
            </AnimatePresence>
          </div>
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}

/**
 * Look up the configured external-agent id whose preset matches `runtime`.
 * Returns null when the user hasn't added one yet — the dispatcher surfaces
 * a friendly "open Settings → External Agents" message in that case.
 */
function resolveExternalAgentIdByPreset(runtime: TeammateRuntime): string | null {
  if (runtime === "claude") return null
  const all = useExternalAgentStore.getState().getAllAgents()
  const match = all.find((a) => {
    const metaPreset = (a.metadata as Record<string, unknown> | undefined)?.preset
    return typeof metaPreset === "string" && metaPreset === runtime && a.enabled
  })
  return match?.id ?? null
}

/**
 * Platform router. The mobile companion renders a read-mostly workspace body
 * (the desktop tab shell has no usable mobile layout); desktop keeps the full
 * inner workspace. Dispatching here — not inside the inner component — keeps
 * the rules-of-hooks intact (each branch is its own component).
 */
function AgentTeamWorkspaceRouter() {
  const platform = usePlatform()
  if (platform === "mobile") return <TeamWorkspaceMobile />
  return <AgentTeamWorkspaceInner />
}

export default function AgentTeamWorkspacePage() {
  return (
    <Suspense fallback={null}>
      <AgentTeamWorkspaceRouter />
    </Suspense>
  )
}
