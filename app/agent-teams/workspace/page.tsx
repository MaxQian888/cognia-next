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

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { useTranslations } from "next-intl"
import { ArrowLeftIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Tabs, TabsContent } from "@/components/ui/tabs"
import { StatusBadge } from "@/components/status-badge"
import { useTeamLiveStatus } from "@/hooks/agent-runs/use-team-live-status"
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
import { AgentTeamMembers } from "@/components/agent/workspace/members"
import { AgentTeamSettings } from "@/components/agent/workspace/settings"
import { WorkspaceTabNav } from "@/components/agent/workspace/workspace-tab-nav"
import { GateModalsHost } from "@/components/agent/team/gate-modals-host"
import { TeamRunsList } from "@/components/agent/team/runs-list"
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
import type {
  AgentTeam,
  AgentTeamEvent,
  AgentTeamMessage,
  AgentTeamTask,
  TeammateRuntime,
} from "@/types/agent/agent-team"

const ALL_TABS = ["overview", "tasks", "chat", "activity", "members", "settings"] as const
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
    [teamId, mentionables, settings, setActiveAgent, executeStreaming, upsertMessage, tComposer]
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

  return (
    <div
      className="flex h-full min-h-0 w-full flex-col space-y-4 overflow-y-auto p-4 sm:p-6"
      data-testid="agent-team-workspace"
      data-bg-target="chat"
    >
      {/* Back + Title */}
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          size="sm"
          className="text-xs"
          onClick={() => router.push("/agent-teams")}
        >
          <ArrowLeftIcon className="mr-1 size-3" />
          {t("listTitle")}
        </Button>
        <span className="hidden sm:inline text-xs text-muted-foreground">/</span>
        <span className="hidden sm:inline text-sm font-medium truncate">{team.name}</span>
        <HeaderLiveStatus team={team} />
      </div>

      <Tabs
        value={tab}
        onValueChange={(v) => setWorkspaceTab(v as typeof activeTab)}
        className="lg:flex-row! lg:items-start lg:gap-5"
      >
        <WorkspaceTabNav />

        <div className="min-w-0 flex-1">
          <TabsContent value="overview" className="pt-4 lg:pt-0">
            <AgentTeamOverview
              team={team}
              teammates={teammates}
              onStart={() => void agentTeamManager.start(team.id).catch(() => undefined)}
              onStartUltracode={() =>
                void agentTeamManager.start(team.id, { ultracode: true }).catch(() => undefined)
              }
              onAbort={() => void abortTeam(team.id, new Error("user-aborted"))}
              onUpdateTeam={(updates) => {
                updateTeam(team.id, updates)
                toast.success(t("teamUpdated"))
              }}
            />
          </TabsContent>
          <TabsContent value="tasks" className="pt-4 lg:pt-0">
            <AgentTeamTasks teamId={team.id} tasks={tasks} teammates={teammates} />
          </TabsContent>
          <TabsContent value="chat" className="pt-4 lg:pt-0">
            <AgentTeamChat
              ref={composerRef}
              teamId={team.id}
              messages={messages}
              mentionables={mentionables}
              onSend={handleSendMention}
              onStop={handleStopDispatch}
              isSending={isSending}
              availability={availability}
              onRetry={handleRetry}
              onDelete={handleDelete}
            />
          </TabsContent>
          <TabsContent value="activity" className="pt-4 lg:pt-0 space-y-4">
            <AgentTeamActivity
              events={events}
              report={team.executionReport}
              team={team}
              teammates={teammates}
            />
            <TeamRunsList teamId={team.id} />
          </TabsContent>
          <TabsContent value="members" className="pt-4 lg:pt-0">
            <AgentTeamMembers team={team} teammates={teammates} leadId={team.leadId} />
          </TabsContent>
          <TabsContent value="settings" className="pt-4 lg:pt-0">
            <AgentTeamSettings team={team} />
          </TabsContent>
        </div>
      </Tabs>

      {/* HITL approval gates (budget / deadlock / teammate-fix) — the consumer
          for usePendingGatesStore; without it a paused run has no release UI. */}
      <GateModalsHost />
    </div>
  )
}

/**
 * Compact live-status pill for the workspace breadcrumb, so the team's run
 * state stays visible from every tab (Overview previously had the only badge).
 * Split out so `useTeamLiveStatus` runs only when a team resolved.
 */
function HeaderLiveStatus({ team }: { team: AgentTeam }) {
  const liveStatus = useTeamLiveStatus(team)
  const isLive = liveStatus === "executing" || liveStatus === "planning"
  return (
    <StatusBadge
      value={liveStatus}
      labelNamespace="agentTeam.status"
      pulse={isLive}
      pulseClassName={isLive ? "bg-emerald-400 size-2" : undefined}
      className="ml-auto shrink-0 sm:ml-1"
      data-testid="workspace-header-status"
    />
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
