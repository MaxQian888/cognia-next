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
import { ArrowLeftIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { cn } from "@/lib/utils"
import { toast } from "sonner"

import { useShallow } from "zustand/react/shallow"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { useExternalAgentStore } from "@/stores/agent/external-agent-store"
import { useExternalAgent } from "@/hooks/agent"
import { useSettingsStore } from "@/stores/settings"
import { agentTeamManager } from "@/lib/ai/agent/agent-team"
import { abortTeam } from "@/lib/ai/agent/agent-team-runtime"
import { AgentTeamOverview } from "@/components/agent/workspace/overview"
import { AgentTeamTasks } from "@/components/agent/workspace/tasks"
import { AgentTeamChat } from "@/components/agent/workspace/chat"
import { AgentTeamActivity } from "@/components/agent/workspace/activity"
import { WorktreesPanel } from "@/components/agent/workspace/worktrees-panel"
import { AgentTeamEditor } from "@/components/agent/workspace/editor/agent-team-editor"
import { AgentTeamMembers } from "@/components/agent/workspace/members"
import { AgentTeamSettings } from "@/components/agent/workspace/settings"
import { WorkspaceTabNav } from "@/components/agent/workspace/workspace-tab-nav"
import { WorkspaceHeader } from "@/components/agent/workspace/workspace-header"
import { GateModalsHost } from "@/components/agent/team/gate-modals-host"
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
  const upsertMessage = useAgentTeamStore((s) => s.upsertMessage)
  const removeMessage = useAgentTeamStore((s) => s.removeMessage)
  const activeTab = useAgentTeamStore((s) => s.workspaceTab)
  const setWorkspaceTab = useAgentTeamStore((s) => s.setWorkspaceTab)
  const setWorkspaceTeamFromRoute = useAgentTeamStore((s) => s.setWorkspaceTeamFromRoute)
  const updateTeam = useAgentTeamStore((s) => s.updateTeam)
  const selectedEditorRoot = useProjectEditorSessionStore((s) =>
    teamId ? s.sessions[`team:${teamId}`]?.rootKey : undefined
  )

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

  // Chat and editor fill the pane as a full-height flex column (header on top,
  // body flex-grows with its own internal scroll) so the lower half of the pane
  // is no longer dead space. The editor additionally *requires* this: in
  // CodeServer mode a native webview is pinned over the pane and cannot follow
  // DOM scroll, so a page that scrolls as a whole makes it visibly tear.
  // Every other tab keeps the classic "page scrolls as a whole" behaviour.
  const isFullHeight = tab === "chat" || tab === "editor"

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
      />

      <SidebarInset
        className={cn("min-h-0", isFullHeight ? "overflow-hidden" : "overflow-y-auto")}
        data-bg-target="chat"
      >
        <div className={cn("flex flex-col gap-4 p-4 sm:p-6", isFullHeight && "min-h-0 flex-1")}>
          <WorkspaceHeader team={team} teammates={teammates} />

          {tab === "overview" && (
            <AgentTeamOverview
              team={team}
              teammates={teammates}
              onStart={() => void agentTeamManager.start(team.id).catch(() => undefined)}
              onStartUltracode={() =>
                void agentTeamManager.start(team.id, { ultracode: true }).catch(() => undefined)
              }
              onAbort={() => void abortTeam(team.id, new Error("user-aborted"))}
              onPause={() => void agentTeamManager.pause(team.id).catch(() => undefined)}
              onResume={() => void agentTeamManager.resume(team.id).catch(() => undefined)}
              onStop={() => void agentTeamManager.shutdown(team.id).catch(() => undefined)}
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
          {tab === "worktrees" && <WorktreesPanel team={team} />}
          {tab === "editor" && <AgentTeamEditor team={team} />}
          {tab === "members" && (
            <AgentTeamMembers team={team} teammates={teammates} leadId={team.leadId} />
          )}
          {tab === "settings" && <AgentTeamSettings team={team} />}
        </div>
      </SidebarInset>

      {/* HITL approval gates (budget / deadlock / teammate-fix) — the consumer
          for usePendingGatesStore; without it a paused run has no release UI. */}
      <GateModalsHost />
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
