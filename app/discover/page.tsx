"use client"

/**
 * Discover tab (Wave 2.4).
 *
 * Mobile-friendly browser of characters, teams, skills, and twin drafts.
 * Exposed at `/discover`; the bottom Tab Bar links into it from the third
 * tab. On desktop the page renders too (no platform gate) so the workflows
 * /agent-teams pages aren't the only window into the catalogue.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"

import { CharacterCard } from "@/components/mobile/discover/character-card"
import { TeamCard } from "@/components/mobile/discover/team-card"
import { SkillCard } from "@/components/mobile/discover/skill-card"
import { TwinDraftsPanel } from "@/components/mobile/discover/twin-drafts-panel"
import { TwinSourcesPanel } from "@/components/mobile/discover/twin-sources-panel"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { listCharacters } from "@/lib/db/characters"
import { listSkills, setSkillStatus } from "@/lib/db/skills"
import { listTeams } from "@/lib/db/teams"
import { getDb } from "@/lib/db/schema"
import type { Character, Skill, Team } from "@/lib/claude/types"
import type { TwinDraft } from "@/types/twin"

type DiscoverTab = "characters" | "teams" | "skills" | "twinDrafts"

const TAB_IDS: DiscoverTab[] = ["characters", "teams", "skills", "twinDrafts"]

export default function DiscoverPage() {
  const t = useTranslations("mobile.discover")
  const [tab, setTab] = useState<DiscoverTab>("characters")

  const characters = useLiveQuery<Character[]>(() => listCharacters(), []) ?? []
  const teams = useLiveQuery<Team[]>(() => listTeams(), []) ?? []
  const skills = useLiveQuery<Skill[]>(() => listSkills(), []) ?? []
  const twinDrafts =
    useLiveQuery<TwinDraft[]>(
      () => getDb().twinDrafts.orderBy("createdAt").reverse().toArray() as Promise<TwinDraft[]>,
      []
    ) ?? []

  const sortedCharacters = useMemo(
    () => characters.slice().sort((a, b) => a.name.localeCompare(b.name)),
    [characters]
  )
  const sortedTeams = useMemo(
    () => teams.slice().sort((a, b) => a.name.localeCompare(b.name)),
    [teams]
  )
  const sortedSkills = useMemo(
    () => skills.slice().sort((a, b) => a.name.localeCompare(b.name)),
    [skills]
  )

  return (
    <main
      className="flex min-h-[100dvh] flex-col bg-background safe-area-pt"
      data-testid="discover-page"
    >
      <header className="px-4 py-3">
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
      </header>

      <Tabs
        value={tab}
        onValueChange={(v) => setTab(v as DiscoverTab)}
        className="flex flex-1 flex-col"
      >
        <TabsList className="mx-4 mb-3 grid grid-cols-4">
          {TAB_IDS.map((id) => (
            <TabsTrigger key={id} value={id} data-testid={`discover-tab-${id}`}>
              {t(`tabs.${id}`)}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="characters" className="flex-1 overflow-y-auto px-4 pb-6">
          {sortedCharacters.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("emptyCharacters")}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {sortedCharacters.map((c) => (
                <li key={c.id}>
                  <CharacterCard character={c} />
                </li>
              ))}
            </ul>
          )}
        </TabsContent>

        <TabsContent value="teams" className="flex-1 overflow-y-auto px-4 pb-6">
          {sortedTeams.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("emptyTeams")}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {sortedTeams.map((tm) => (
                <li key={tm.id}>
                  <TeamCard team={tm} />
                </li>
              ))}
            </ul>
          )}
        </TabsContent>

        <TabsContent value="skills" className="flex-1 overflow-y-auto px-4 pb-6">
          {sortedSkills.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("emptySkills")}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {sortedSkills.map((s) => (
                <li key={s.id}>
                  <SkillCard
                    skill={s}
                    onToggle={(skill) =>
                      void setSkillStatus(
                        skill.id,
                        skill.status === "disabled" ? "enabled" : "disabled"
                      )
                    }
                  />
                </li>
              ))}
            </ul>
          )}
        </TabsContent>

        <TabsContent value="twinDrafts" className="flex-1 overflow-y-auto px-4 pb-6">
          <TwinSourcesPanel />
          <hr className="my-4 border-border" />
          {twinDrafts.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("emptyTwinDrafts")}</p>
          ) : (
            <TwinDraftsPanel />
          )}
        </TabsContent>
      </Tabs>
    </main>
  )
}
