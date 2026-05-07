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
import {
  ActivityIcon,
  ArrowLeftIcon,
  BarChart3Icon,
  MessageCircleIcon,
  Settings2Icon,
  ListTodoIcon,
  UsersIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { toast } from "sonner"

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
import type { ComposerHandle } from "@/components/chat/composer"

import { parseLeadingMention } from "@/lib/agent-team/mention-parser"
import {
  buildMentionableTargets,
  findTargetById,
  targetsToCandidates,
} from "@/lib/agent-team/runtime-targets"
import { dispatchTeamMention } from "@/lib/agent-team/team-runtime-dispatcher"
import { createCompositeStreamer } from "@/lib/agent-team/runtime-streamers"
import { useRuntimeAvailability } from "@/lib/agent-team/use-runtime-availability"
import { buildConversationHistory } from "@/lib/agent-team/conversation-context"
import { getProviderModel } from "@/lib/ai/core/client"
import type { TeammateRuntime } from "@/types/agent/agent-team"

const ALL_TABS = ["overview", "tasks", "chat", "activity", "members", "settings"] as const
type Tab = (typeof ALL_TABS)[number]

function AgentTeamWorkspaceInner() {
  const searchParams = useSearchParams()
  const teamId = searchParams.get("teamId")
  const router = useRouter()
  const t = useTranslations("agentTeamsWorkspace")
  const tTabs = useTranslations("agentTeamsWorkspace.tabs")
  const tComposer = useTranslations("agentTeamsWorkspace.chat.composer")

  const team = useAgentTeamStore((s) => (teamId ? s.teams[teamId] : undefined))
  const teammates = useAgentTeamStore((s) =>
    Object.values(s.teammates).filter((m) => m.teamId === teamId)
  )
  const tasks = useAgentTeamStore((s) =>
    Object.values(s.tasks).filter((task) => task.teamId === teamId)
  )
  const messages = useAgentTeamStore((s) =>
    Object.values(s.messages).filter((m) => m.teamId === teamId)
  )
  const events = useAgentTeamStore((s) => s.events.filter((e) => e.teamId === teamId))
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

  // Snapshot the latest messages in a ref so handlers (which are memoised)
  // always read the freshest list when building conversation history.
  const messagesRef = useRef(messages)
  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  const dispatchPair = useCallback(
    async (params: { targetId: string; prompt: string; rawText: string }): Promise<void> => {
      if (!teamId) return
      const target = findTargetById(mentionables, params.targetId)
      if (!target) {
        toast.error(tComposer("unknownAgent", { name: params.targetId }))
        return
      }

      const apiKey = settings?.apiKey ?? ""
      const model = getProviderModel({
        provider: "anthropic",
        model: settings?.defaultModel ?? "claude-sonnet-4-5",
        apiKey,
      })
      const streamer = createCompositeStreamer({
        claude: { model },
        external: {
          setActiveAgent,
          executeStreaming,
          resolveAgentId: (runtime: TeammateRuntime) => resolveExternalAgentIdByPreset(runtime),
        },
      })

      const history = buildConversationHistory(messagesRef.current)

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
    <div className="mx-auto max-w-5xl space-y-4 p-4 sm:p-6" data-testid="agent-team-workspace">
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
      </div>

      <Tabs value={tab} onValueChange={(v) => setWorkspaceTab(v as typeof activeTab)}>
        <div className="overflow-x-auto">
          <TabsList className="inline-flex h-9 w-max gap-1">
            <TabsTrigger value="overview" data-testid="tab-overview" className="gap-1.5">
              <BarChart3Icon className="size-3.5 sm:hidden" />
              <span className="hidden sm:inline">{tTabs("overview")}</span>
            </TabsTrigger>
            <TabsTrigger value="tasks" data-testid="tab-tasks" className="gap-1.5">
              <ListTodoIcon className="size-3.5 sm:hidden" />
              <span className="hidden sm:inline">{tTabs("tasks")}</span>
            </TabsTrigger>
            <TabsTrigger value="chat" data-testid="tab-chat" className="gap-1.5">
              <MessageCircleIcon className="size-3.5 sm:hidden" />
              <span className="hidden sm:inline">{tTabs("chat")}</span>
            </TabsTrigger>
            <TabsTrigger value="activity" data-testid="tab-activity" className="gap-1.5">
              <ActivityIcon className="size-3.5 sm:hidden" />
              <span className="hidden sm:inline">{tTabs("activity")}</span>
            </TabsTrigger>
            <TabsTrigger value="members" data-testid="tab-members" className="gap-1.5">
              <UsersIcon className="size-3.5 sm:hidden" />
              <span className="hidden sm:inline">{tTabs("members")}</span>
            </TabsTrigger>
            <TabsTrigger value="settings" data-testid="tab-settings" className="gap-1.5">
              <Settings2Icon className="size-3.5 sm:hidden" />
              <span className="hidden sm:inline">{tTabs("settings")}</span>
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="overview" className="pt-4">
          <AgentTeamOverview
            team={team}
            teammates={teammates}
            onStart={() => void agentTeamManager.start(team.id).catch(() => undefined)}
            onAbort={() => void abortTeam(team.id, new Error("user-aborted"))}
            onUpdateTeam={(updates) => {
              updateTeam(team.id, updates)
              toast.success(t("teamUpdated"))
            }}
          />
        </TabsContent>
        <TabsContent value="tasks" className="pt-4">
          <AgentTeamTasks teamId={team.id} tasks={tasks} teammates={teammates} />
        </TabsContent>
        <TabsContent value="chat" className="pt-4">
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
        <TabsContent value="activity" className="pt-4">
          <AgentTeamActivity events={events} />
        </TabsContent>
        <TabsContent value="members" className="pt-4">
          <AgentTeamMembers teamId={team.id} teammates={teammates} leadId={team.leadId} />
        </TabsContent>
        <TabsContent value="settings" className="pt-4">
          <AgentTeamSettings team={team} />
        </TabsContent>
      </Tabs>
    </div>
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

export default function AgentTeamWorkspacePage() {
  return (
    <Suspense fallback={null}>
      <AgentTeamWorkspaceInner />
    </Suspense>
  )
}
