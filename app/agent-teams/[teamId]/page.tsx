"use client"

/**
 * Agent Teams workspace — per-team detail page.
 *
 * Tabbed shell driven by the store's `workspaceTab`. Reads the team via
 * the existing selectors. Wires the Run / Stop buttons in the Overview
 * tab to `agentTeamManager.start` / `pause`.
 */

import { use as usePromise } from "react"
import { useRouter } from "next/navigation"
import { useEffect } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { agentTeamManager } from "@/lib/ai/agent/agent-team"
import { abortTeam } from "@/lib/ai/agent/agent-team-runtime"
import { AgentTeamOverview } from "@/components/agent/workspace/overview"
import { AgentTeamTasks } from "@/components/agent/workspace/tasks"
import { AgentTeamChat } from "@/components/agent/workspace/chat"
import { AgentTeamActivity } from "@/components/agent/workspace/activity"

interface PageProps {
  params: Promise<{ teamId: string }>
}

export default function AgentTeamWorkspacePage({ params }: PageProps) {
  const { teamId } = usePromise(params)
  const router = useRouter()
  const t = useTranslations("agentTeamsWorkspace")
  const tTabs = useTranslations("agentTeamsWorkspace.tabs")

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
  const activeTab = useAgentTeamStore((s) => s.workspaceTab)
  const setWorkspaceTab = useAgentTeamStore((s) => s.setWorkspaceTab)
  const setWorkspaceTeamFromRoute = useAgentTeamStore((s) => s.setWorkspaceTeamFromRoute)

  // Sync the URL teamId into the store so selectors that depend on
  // `activeTeamId` resolve correctly.
  useEffect(() => {
    setWorkspaceTeamFromRoute(teamId ?? null)
    return () => setWorkspaceTeamFromRoute(null)
  }, [teamId, setWorkspaceTeamFromRoute])

  if (!team) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <Card className="space-y-2 p-6 text-center text-sm text-muted-foreground">
          <p>{t("missing")}</p>
          <Button variant="outline" size="sm" onClick={() => router.push("/agent-teams")}>
            ← {t("listTitle")}
          </Button>
        </Card>
      </div>
    )
  }

  // Filter to the four tabs we ship; ignore graph/analytics for now.
  const tab: "overview" | "tasks" | "chat" | "activity" =
    activeTab === "tasks" || activeTab === "chat" || activeTab === "activity"
      ? activeTab
      : "overview"

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-6" data-testid="agent-team-workspace">
      <Button
        variant="ghost"
        size="sm"
        className="text-xs"
        onClick={() => router.push("/agent-teams")}
      >
        ← {t("listTitle")}
      </Button>

      <Tabs value={tab} onValueChange={(v) => setWorkspaceTab(v as typeof activeTab)}>
        <TabsList>
          <TabsTrigger value="overview" data-testid="tab-overview">
            {tTabs("overview")}
          </TabsTrigger>
          <TabsTrigger value="tasks" data-testid="tab-tasks">
            {tTabs("tasks")}
          </TabsTrigger>
          <TabsTrigger value="chat" data-testid="tab-chat">
            {tTabs("chat")}
          </TabsTrigger>
          <TabsTrigger value="activity" data-testid="tab-activity">
            {tTabs("activity")}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          <AgentTeamOverview
            team={team}
            teammates={teammates}
            onStart={() => void agentTeamManager.start(team.id).catch(() => undefined)}
            onAbort={() => void abortTeam(team.id, new Error("user-aborted"))}
          />
        </TabsContent>
        <TabsContent value="tasks">
          <AgentTeamTasks tasks={tasks} />
        </TabsContent>
        <TabsContent value="chat">
          <AgentTeamChat messages={messages} />
        </TabsContent>
        <TabsContent value="activity">
          <AgentTeamActivity events={events} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
