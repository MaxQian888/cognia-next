"use client"

/**
 * Mobile companion Agent-Teams workspace (closes the raw-desktop-page gap).
 *
 * The mobile Discover `TeamCard` links to `/agent-teams/workspace?teamId=…`,
 * which on the phone previously rendered the full desktop 6-tab shell. This
 * read-mostly body reuses the same workspace sections (Overview / Members /
 * Activity + run history) from the on-device `useAgentTeamStore` and wires
 * Run / Stop through `agentTeamManager`. The @mention composer (Chat tab) and
 * the Settings tab stay desktop-only.
 *
 * Paired-phone reality check: the local store only has content when the team
 * was authored ON this device. A paired phone mirrors the desktop's board via
 * the Dexie `agentTeamBoard` sync table (v104) instead — when the store is
 * empty but a synced team-meta row exists, this page falls back to the Board
 * tab alone (the synced surface), with controls round-tripping as Companion
 * RPCs.
 */

import { useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { useTranslations } from "next-intl"
import { useShallow } from "zustand/react/shallow"
import { useLiveQuery } from "dexie-react-hooks"
import { ArrowLeftIcon, UsersIcon } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { EmptyState } from "@/components/mobile/empty-state"
import { AgentTeamOverview } from "@/components/agent/workspace/overview"
import { AgentTeamMembers } from "@/components/agent/workspace/members"
import { AgentTeamActivity } from "@/components/agent/workspace/activity"
import { TeamRunsList } from "@/components/agent/team/runs-list"
import { GateModalsHost } from "@/components/agent/team/gate-modals-host"
import { TeamBoardMobile } from "@/components/mobile/agent-teams/team-board-mobile"
import { agentTeamManager } from "@/lib/ai/agent/agent-team"
import { abortTeam } from "@/lib/ai/agent/agent-team-runtime"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { getAgentTeamBoardTeamRow } from "@/lib/db/agent-team-board"

export function TeamWorkspaceMobile() {
  const searchParams = useSearchParams()
  const teamId = searchParams.get("teamId")
  const router = useRouter()
  const t = useTranslations("agentTeamsWorkspace")
  const tm = useTranslations("mobile.agentTeams")

  const team = useAgentTeamStore((s) => (teamId ? s.teams[teamId] : undefined))
  const teammates = useAgentTeamStore(
    useShallow((s) => Object.values(s.teammates).filter((m) => m.teamId === teamId))
  )
  const events = useAgentTeamStore(useShallow((s) => s.events.filter((e) => e.teamId === teamId)))
  const updateTeam = useAgentTeamStore((s) => s.updateTeam)

  const [tab, setTab] = useState<"overview" | "board" | "members" | "activity">("overview")

  // Paired-phone fallback: a synced team-meta row proves the team exists on
  // the desktop even when the local store is empty.
  const syncedMeta = useLiveQuery(
    () => (teamId ? getAgentTeamBoardTeamRow(teamId) : undefined),
    [teamId]
  )

  if (!team && syncedMeta && teamId) {
    return (
      <main
        className="flex min-h-[100dvh] flex-col gap-3 bg-background pt-3 safe-area-pt"
        data-testid="mobile-team-workspace"
        data-bg-target="chat"
      >
        <header className="flex items-center gap-2 px-4">
          <Button
            variant="ghost"
            size="sm"
            className="-ml-2 text-xs"
            onClick={() => router.push("/discover")}
            data-testid="mobile-team-back"
          >
            <ArrowLeftIcon className="mr-1 size-3" />
            {tm("backToTeams")}
          </Button>
          <span className="truncate text-sm font-semibold">{syncedMeta.name}</span>
        </header>
        <div className="px-4 pb-4">
          <TeamBoardMobile teamId={teamId} />
        </div>
      </main>
    )
  }

  if (!team) {
    return (
      <main
        className="flex min-h-[100dvh] flex-col bg-background pt-3 safe-area-pt"
        data-testid="mobile-team-workspace"
      >
        <div className="px-4">
          <EmptyState
            icon={UsersIcon}
            title={t("missing")}
            cta={{
              label: tm("backToTeams"),
              onSelect: () => router.push("/discover"),
              testId: "mobile-team-back",
            }}
          />
        </div>
      </main>
    )
  }

  return (
    <main
      className="flex min-h-[100dvh] flex-col gap-3 bg-background pt-3 safe-area-pt"
      data-testid="mobile-team-workspace"
      data-bg-target="chat"
    >
      <header className="flex items-center gap-2 px-4">
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2 text-xs"
          onClick={() => router.push("/discover")}
          data-testid="mobile-team-back"
        >
          <ArrowLeftIcon className="mr-1 size-3" />
          {tm("backToTeams")}
        </Button>
        <span className="truncate text-sm font-semibold">{team.name}</span>
      </header>

      <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)} className="flex-1">
        <TabsList className="mx-4 grid grid-cols-4">
          <TabsTrigger value="overview" data-testid="mobile-team-tab-overview">
            {tm("tabs.overview")}
          </TabsTrigger>
          <TabsTrigger value="board" data-testid="mobile-team-tab-board">
            {tm("tabs.board")}
          </TabsTrigger>
          <TabsTrigger value="members" data-testid="mobile-team-tab-members">
            {tm("tabs.members")}
          </TabsTrigger>
          <TabsTrigger value="activity" data-testid="mobile-team-tab-activity">
            {tm("tabs.activity")}
          </TabsTrigger>
        </TabsList>

        <div className="px-4 pb-4 pt-3">
          <TabsContent value="board">
            <TeamBoardMobile teamId={team.id} />
          </TabsContent>
          <TabsContent value="overview">
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
          <TabsContent value="members">
            <AgentTeamMembers team={team} teammates={teammates} leadId={team.leadId} />
          </TabsContent>
          <TabsContent value="activity" className="space-y-4">
            <AgentTeamActivity
              events={events}
              report={team.executionReport}
              team={team}
              teammates={teammates}
            />
            <TeamRunsList teamId={team.id} />
          </TabsContent>
        </div>
      </Tabs>

      <GateModalsHost />
    </main>
  )
}
