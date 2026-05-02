"use client"

/**
 * Agent Teams workspace — landing page.
 *
 * Lists every team the user has created plus the eight built-in
 * templates as a Quick Start card grid. Selecting a team navigates
 * to `/agent-teams/[teamId]`. Picking a template instantiates a fresh
 * team via the store's `createTeam` action and routes to its workspace.
 */

import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { BUILT_IN_TEAM_TEMPLATES, type AgentTeamTemplate } from "@/types/agent/agent-team"

export default function AgentTeamsListPage() {
  const router = useRouter()
  const t = useTranslations("agentTeamsWorkspace")
  const tCat = useTranslations("agentTeamsWorkspace.templates.categories")
  const teams = useAgentTeamStore((s) => s.teams)
  const createTeam = useAgentTeamStore((s) => s.createTeam)
  const addTeammate = useAgentTeamStore((s) => s.addTeammate)

  const teamList = Object.values(teams).sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  )

  const onPickTemplate = (tpl: AgentTeamTemplate) => {
    const team = createTeam({
      name: tpl.name,
      description: tpl.description,
      task: tpl.description,
      config: tpl.config,
    })
    // Spawn a teammate slot per template entry. The template's own teammate
    // metadata (specialization, config) carries over.
    for (const tm of tpl.teammates) {
      addTeammate({
        teamId: team.id,
        name: tm.name,
        description: tm.description,
        role: "teammate",
        config: tm.config,
      })
    }
    router.push(`/agent-teams/${team.id}`)
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6" data-testid="agent-teams-list-page">
      <div className="space-y-1">
        <Label className="text-lg font-semibold">{t("listTitle")}</Label>
        <p className="text-sm text-muted-foreground">{t("listDescription")}</p>
      </div>

      {teamList.length === 0 ? (
        <Card className="p-6 text-center text-sm text-muted-foreground" data-testid="teams-empty">
          {t("listEmpty")}
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {teamList.map((team) => (
            <Card
              key={team.id}
              className="cursor-pointer space-y-2 p-4 transition hover:border-primary"
              data-testid={`team-card-${team.id}`}
              onClick={() => router.push(`/agent-teams/${team.id}`)}
            >
              <p className="text-sm font-medium">{team.name}</p>
              <p className="line-clamp-2 text-xs text-muted-foreground">{team.description}</p>
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                {team.status}
              </p>
            </Card>
          ))}
        </div>
      )}

      <div className="space-y-2 pt-4">
        <Label className="text-sm font-semibold">{t("newFromTemplate")}</Label>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {BUILT_IN_TEAM_TEMPLATES.map((tpl) => (
            <Card key={tpl.id} className="space-y-2 p-4" data-testid={`template-card-${tpl.id}`}>
              <div className="flex items-start justify-between gap-2">
                <p className="text-sm font-medium">{tpl.name}</p>
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  {tCat(tpl.category)}
                </span>
              </div>
              <p className="line-clamp-3 text-xs text-muted-foreground">{tpl.description}</p>
              <div className="flex justify-end">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onPickTemplate(tpl)}
                  data-testid={`template-pick-${tpl.id}`}
                >
                  {t("createTeam")}
                </Button>
              </div>
            </Card>
          ))}
        </div>
      </div>
    </div>
  )
}
